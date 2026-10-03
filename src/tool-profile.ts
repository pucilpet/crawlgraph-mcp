import { McpServer, type RegisteredTool, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InvalidTokenError, InsufficientScopeError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { CallToolRequestSchema, ErrorCode, McpError, ListResourcesRequestSchema, ListPromptsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  BackendExecutionError, CONNECTOR_SCOPE, directoryDomainSchema, directoryLimitSchema, directoryReleaseSchema,
  directoryBacklinksSchema, directoryChangesSchema, directoryGapResultSchema, directoryGapRowSchema,
  directoryJobSchema, directoryReleasesSchema, executionReplySchema, quotaSchema,
  connectorRequestId, logConnectorTelemetry,
  type BackendClient, type ExecuteCommand, type ExecutionReply, type QuotaCategory, type QuotaSnapshot,
} from "./backend-client.js";
import { connectorChallenge, type ProtectedConnectorContext } from "./oauth/router.js";

const RESULT_BYTES = 64 * 1024;
const TOOL_MS = 90_000;
const POLL_MS = 75_000;
const RETURN_MARGIN_MS = 2_000;
const ENRICHMENT_RESERVE_BYTES = 8 * 1024;
const opaqueJobId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).refine(value => !value.startsWith("cgc_"));
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const toolNameSchema = z.enum(["backlinks", "backlink_changes", "gap_analysis", "gap_outreach_targets", "releases", "unknown"]);
type ToolName = z.infer<typeof toolNameSchema>;
const purposeSchema = z.enum(["gap_analysis", "gap_outreach_targets"]);
const gapInputShape = {
  my_domain: directoryDomainSchema,
  competitor_domains: z.array(directoryDomainSchema).min(1).max(5)
    .transform(values => [...new Set(values)].sort()),
  limit: directoryLimitSchema,
  job_id: opaqueJobId.optional().describe("Resume this tool's existing job without submitting or charging another gap job."),
};
const backlinksInput = z.object({ domain: directoryDomainSchema, limit: directoryLimitSchema,
  sort: z.enum(["authority", "hosts"]).default("authority"), release_id: directoryReleaseSchema.optional() }).strict();
const changesInput = z.object({ domain: directoryDomainSchema, limit: directoryLimitSchema,
  from_release: directoryReleaseSchema.optional(), to_release: directoryReleaseSchema.optional() }).strict();
const releasesInput = z.object({ limit: directoryLimitSchema }).strict();
const gapInput = z.object(gapInputShape).strict();
const outreachInput = z.object({ ...gapInputShape, include_platforms: z.boolean().default(false),
  enrich_authority_top: z.number().int().min(0).max(5).default(0)
    .describe("Explicit extra backlinks lookups for up to five returned targets, costing one backlinks call each; default zero.") }).strict();

const safeCodeSchema = z.enum(["invalid_token", "insufficient_scope", "temporarily_unavailable", "invalid_response",
  "cancelled", "deadline_exceeded", "validation_error", "quota_exceeded", "upgrade_required", "release_unavailable",
  "not_found", "job_stale", "operation_failed", "internal_error", "rate_limited", "authority_unavailable"]);
type SafeCode = z.infer<typeof safeCodeSchema>;
const EXPIRED_AUTH_MESSAGE = "The connector access token is no longer valid.";

const safeMessages: Record<SafeCode, string> = {
  invalid_token: EXPIRED_AUTH_MESSAGE,
  insufficient_scope: "The connector requires crawlgraph:read scope.",
  temporarily_unavailable: "The research service is temporarily unavailable.",
  invalid_response: "The research service returned an invalid or oversized response.",
  cancelled: "This tool call was cancelled; no further operations were started.",
  deadline_exceeded: "The polling or execution deadline was reached.",
  validation_error: "The research request is invalid.", quota_exceeded: "The monthly research quota is exhausted.",
  upgrade_required: "Gap research requires current paid access.",
  release_unavailable: "The requested release is unavailable for queries.", not_found: "The matching research job was not found.",
  job_stale: "The worker may still complete. Resume this job later without resubmitting; no mutation or refund was performed.",
  operation_failed: "The research operation could not be completed.", internal_error: "The research result is unavailable.",
  rate_limited: "The research service rate limit was reached.",
  authority_unavailable: "Target authority or rank was unavailable in this lookup. Any observed job authority was retained.",
};
const safeErrorSchema = z.object({ code: safeCodeSchema, message: z.string().max(256) }).strict();
type SafeError = z.infer<typeof safeErrorSchema>;
function safeError(code: string): SafeError {
  const parsed = safeCodeSchema.safeParse(code);
  const safe = parsed.success ? parsed.data : "temporarily_unavailable";
  return { code: safe, message: safeMessages[safe] };
}
const partialErrorSchema = safeErrorSchema.extend({ operation: z.string().max(32), linking_domain: z.string().max(253).optional() }).strict();
const enrichmentSchema = z.object({
  linking_domain: z.string().max(253), status: z.enum(["complete", "partial", "unavailable", "error"]),
  release_id: z.string().max(128).nullable(), provenance_scope: z.enum(["job_release", "separate_lookup_release"]),
  cg_authority: count.max(100).nullable(), cg_rank: count.nullable(), error: safeErrorSchema.nullable(),
}).strict();
const outreachRowSchema = directoryGapRowSchema.extend({ overlap: count.max(5), cg_rank: count.nullable().optional() }).strict();
const outreachResultSchema = directoryGapResultSchema.omit({ gaps: true }).extend({
  priority_targets: z.array(outreachRowSchema).max(100), secondary_targets: z.array(outreachRowSchema).max(100),
  sample_rows_considered: count.max(100), platforms_filtered: count.max(100), filter_count_scope: z.literal("returned_backend_sample"),
  authority_enriched: count.max(5), enrichment_requested: count.max(5), enrichment: z.array(enrichmentSchema).max(5),
  research_only: z.literal(true),
}).strict();
const outreachJobSchema = directoryJobSchema.omit({ result: true }).extend({ result: outreachResultSchema.nullable().optional() }).strict();
const changesResultSchema = directoryChangesSchema.extend({ counts: directoryChangesSchema.shape.counts.nullable() }).strict();
const requestSchema = z.union([
  backlinksInput.extend({ tool: z.literal("backlinks") }), changesInput.extend({ tool: z.literal("backlink_changes") }),
  gapInput.extend({ tool: z.literal("gap_analysis"), purpose: z.literal("gap_analysis") }),
  outreachInput.extend({ tool: z.literal("gap_outreach_targets"), purpose: z.literal("gap_outreach_targets") }),
  releasesInput.extend({ tool: z.literal("releases") }),
  z.object({ tool: toolNameSchema, invalid_input: z.boolean() }).strict(),
]);
const directoryEnvelopeSchema = z.object({
  status: z.enum(["complete", "pending", "unavailable", "error"]), request: requestSchema,
  job_id: opaqueJobId.optional(), resume_advice: z.string().max(256).optional(),
  data: z.union([directoryBacklinksSchema, changesResultSchema, directoryJobSchema, outreachJobSchema, directoryReleasesSchema]).nullable(),
  error: safeErrorSchema.nullable(), partial_errors: z.array(partialErrorSchema).max(8),
  quota_consumed: z.object({ backlinks: z.union([count, z.literal("UNKNOWN")]), gap: z.union([count, z.literal("UNKNOWN")]) }).strict(),
  quota_consumed_known: z.object({ backlinks: count, gap: count }).strict(),
  unknown_consumption_categories: z.array(z.enum(["backlinks", "gap"])).max(2),
  quota: z.array(quotaSchema).max(2),
}).strict();
type DirectoryEnvelope = z.infer<typeof directoryEnvelopeSchema>;
type OutreachResult = z.infer<typeof outreachResultSchema>;
const outputMetaSchema = z.object({
  max_bytes: z.literal(RESULT_BYTES), output_capped: z.boolean(),
  backend_returned: z.record(count), returned: z.record(count), omitted_rows: z.record(count),
  disclosure: z.string().max(256),
}).strict();
const resultSchema = z.object({ content: z.array(z.object({ type: z.literal("text"), text: z.string().max(512) }).strict()).length(1),
  isError: z.boolean().optional(), structuredContent: directoryEnvelopeSchema,
  _meta: z.object({ "mcp/www_authenticate": z.array(z.string().max(512)).max(1).optional(),
    "crawlgraph/output": outputMetaSchema }).strict(),
}).strict();
type DirectoryResult = z.infer<typeof resultSchema>;

export interface DirectoryFactoryOptions {
  version: string;
  /** Programmatic seams only; production uses a monotonic clock and abortable waits. */
  now?: () => number;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}
export type DirectoryBackend = Pick<BackendClient, "execute">;

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () => reject(new BackendExecutionError("cancelled", false));
    if (signal.aborted) { void operation.catch(() => {}); stop(); return; }
    signal.addEventListener("abort", stop, { once: true });
    operation.then(value => { signal.removeEventListener("abort", stop); resolve(value); },
      error => { signal.removeEventListener("abort", stop); reject(error); });
  });
}
function defaultWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); reject(new BackendExecutionError("cancelled", false)); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, milliseconds);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
  });
}
function combineSignals(signals: AbortSignal[]): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const stop = () => controller.abort();
  for (const signal of signals) {
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
  }
  return { signal: controller.signal, cleanup: () => {
    for (const signal of signals) signal.removeEventListener("abort", stop);
  } };
}
function chargedCategory(operation: ExecuteCommand["operation"]): QuotaCategory | undefined {
  return operation === "backlinks" || operation === "changes" ? "backlinks" : operation === "gap_submit" ? "gap" : undefined;
}
class ToolCall {
  readonly known = { backlinks: 0, gap: 0 };
  readonly unknown = new Set<QuotaCategory>();
  readonly quotas = new Map<QuotaCategory, QuotaSnapshot>();
  readonly partialErrors: DirectoryEnvelope["partial_errors"] = [];
  readonly started: number;
  readonly deadline: number;
  readonly now: () => number;
  constructor(readonly context: ProtectedConnectorContext, readonly backend: DirectoryBackend,
    readonly signal: AbortSignal, readonly options: DirectoryFactoryOptions) {
    this.now = options.now ?? (() => performance.now());
    this.started = this.now();
    this.deadline = this.started + TOOL_MS - RETURN_MARGIN_MS;
  }
  async execute(command: ExecuteCommand, end = this.deadline, signal = this.signal): Promise<ExecutionReply> {
    let started = false;
    const category = chargedCategory(command.operation);
    try {
      const remaining = Math.min(15_000, end - this.now());
      if (signal.aborted) throw new BackendExecutionError("cancelled", false);
      if (remaining <= 0) throw new BackendExecutionError("deadline_exceeded", false);
      started = true;
      const reply = executionReplySchema.parse(await this.backend.execute(command, this.context.auth.token,
        this.context.ingress, signal, remaining));
      if (reply.operation !== command.operation) throw new BackendExecutionError("invalid_response", true);
      if (reply.quota_consumed.category) this.known[reply.quota_consumed.category] += reply.quota_consumed.count;
      for (const quota of reply.quota) this.quotas.set(quota.kind, quota);
      return reply;
    } catch (error) {
      const failure = error instanceof BackendExecutionError ? error : new BackendExecutionError("invalid_response", started);
      if (category && failure.consumptionUnknown) this.unknown.add(category);
      throw failure;
    }
  }
  accounting() {
    return {
      quota_consumed: { backlinks: this.unknown.has("backlinks") ? "UNKNOWN" as const : this.known.backlinks,
        gap: this.unknown.has("gap") ? "UNKNOWN" as const : this.known.gap },
      quota_consumed_known: { ...this.known }, unknown_consumption_categories: [...this.unknown].sort(),
      quota: [...this.quotas.values()], partial_errors: this.partialErrors,
    };
  }
}

function authenticationChallenge(envelope: DirectoryEnvelope): string | undefined {
  const error = [envelope.error, ...envelope.partial_errors].find(item => item?.code === "invalid_token" || item?.code === "insufficient_scope");
  return error ? connectorChallenge(error.code === "insufficient_scope" ? new InsufficientScopeError("Required scope missing") : new InvalidTokenError("Invalid access token")) : undefined;
}
type RowList = { key: string; rows: { linking_domain?: string }[]; remove: (index: number) => void };
function rowLists(data: DirectoryEnvelope["data"]): RowList[] {
  if (!data) return [];
  const list = (key: string, rows: { linking_domain?: string }[]): RowList => ({ key, rows, remove: index => { rows.splice(index, 1); } });
  if ("results" in data) return [list("results", data.results)];
  if ("added" in data) return [list("added", data.added), list("removed", data.removed), list("authority_moved", data.authority_moved)];
  if ("releases" in data) return [{ key: "releases", rows: data.releases.map(() => ({})), remove: index => { data.releases.splice(index, 1); } }];
  if (data.result) {
    if ("gaps" in data.result) return [list("gaps", data.result.gaps)];
    return [list("secondary_targets", data.result.secondary_targets), list("priority_targets", data.result.priority_targets)];
  }
  return [];
}
function updateReturned(data: DirectoryEnvelope["data"], trimmed: boolean): void {
  if (!data) return;
  if ("results" in data) { data.returned = data.results.length; data.truncated ||= trimmed; }
  else if ("added" in data) {
    data.returned = { added: data.added.length, removed: data.removed.length, authority_moved: data.authority_moved.length };
    data.truncated ||= trimmed;
  } else if ("result" in data && data.result) {
    const result = data.result;
    result.returned = "gaps" in result ? result.gaps.length : result.priority_targets.length + result.secondary_targets.length;
    result.truncated ||= trimmed;
  }
}
function summary(envelope: DirectoryEnvelope): string {
  if (envelope.status === "pending") return "Research job pending. Resume this same tool with the returned job_id and normalized request; polling consumes zero gap calls.";
  if (envelope.status === "error") return envelope.error?.message ?? "The research operation could not be completed.";
  if (envelope.status === "unavailable") return "Snapshot comparison unavailable. Unavailable counts are not evidence of zero changes.";
  return "Research results are in structuredContent. Lists are capped; totals, source limitations, provenance and quota accounting are preserved. Common Crawl observations do not prove live links.";
}
function makeResult(envelope: DirectoryEnvelope): DirectoryResult {
  const challenge = authenticationChallenge(envelope);
  const rows = Object.fromEntries(rowLists(envelope.data).map(list => [list.key, list.rows.length]));
  return {
    content: [{ type: "text", text: summary(envelope) }], structuredContent: envelope,
    ...(envelope.status === "error" || challenge ? { isError: true } : {}),
    _meta: { ...(challenge ? { "mcp/www_authenticate": [challenge] } : {}), "crawlgraph/output": {
      max_bytes: RESULT_BYTES, output_capped: false, backend_returned: { ...rows }, returned: { ...rows }, omitted_rows: {},
      disclosure: "Lists default to 20 and never exceed 100 rows. Backend totals and source caps describe observations, not global opportunity counts.",
    } },
  };
}
function fitResult(result: DirectoryResult, reserve = 0, protectedDomains = new Set<string>()): DirectoryResult {
  const meta = result._meta["crawlgraph/output"];
  const bytes = () => Buffer.byteLength(JSON.stringify(result), "utf8");
  while (bytes() > RESULT_BYTES - reserve) {
    const lists = rowLists(result.structuredContent.data);
    // Secondary research candidates are reduced first. Other lists reduce their
    // longest tail; retained rows keep their backend order, including charged enrichment.
    if (!lists.some(list => list.key === "secondary_targets")) lists.sort((a, b) => b.rows.length - a.rows.length || a.key.localeCompare(b.key));
    let removed = false;
    for (const list of lists) {
      let index = list.rows.length - 1;
      while (index >= 0 && list.rows[index].linking_domain && protectedDomains.has(list.rows[index].linking_domain!)) index--;
      if (index < 0) continue;
      list.remove(index);
      meta.omitted_rows[list.key] = (meta.omitted_rows[list.key] ?? 0) + 1;
      meta.output_capped = true;
      removed = true;
      break;
    }
    if (!removed) throw new BackendExecutionError("invalid_response", false);
    updateReturned(result.structuredContent.data, true);
    meta.returned = Object.fromEntries(rowLists(result.structuredContent.data).map(list => [list.key, list.rows.length]));
    meta.disclosure = "Output lists were additionally reduced to fit the complete 64 KiB UTF-8 result budget. Full backend totals, source caps, provenance and accounting remain unchanged.";
  }
  const validated = resultSchema.parse(result);
  if (Buffer.byteLength(JSON.stringify(validated), "utf8") > RESULT_BYTES - reserve) throw new BackendExecutionError("invalid_response", false);
  return validated;
}

const PLATFORM_NOISE = new Set([
  "amazonaws.com", "cloudfront.net", "googleusercontent.com", "azurewebsites.net", "herokuapp.com", "netlify.app", "vercel.app",
  "github.io", "githubusercontent.com", "cloudflare.com", "akamai.net", "fastly.net", "wp.com", "wordpress.com", "blogspot.com",
  "medium.com", "shopify.com", "myshopify.com", "wixsite.com", "squarespace.com", "weebly.com", "godaddy.com", "google.com",
  "youtube.com", "facebook.com", "instagram.com", "twitter.com", "x.com", "linkedin.com", "pinterest.com", "reddit.com", "tiktok.com",
  "apple.com", "microsoft.com", "adobe.com", "amazon.com", "alibaba.com", "yahoo.com", "bing.com", "wikipedia.org", "archive.org",
  "gravatar.com", "bit.ly", "t.co", "goo.gl", "ow.ly", "feedburner.com", "doubleclick.net",
]);
function isPlatformNoise(domain: string): boolean {
  return [...PLATFORM_NOISE].some(platform => domain === platform || domain.endsWith(`.${platform}`));
}
function outreachResult(result: z.infer<typeof directoryGapResultSchema>, includePlatforms: boolean, requested: number): OutreachResult {
  const { gaps, ...metadata } = result;
  const kept = gaps.filter(row => includePlatforms || !isPlatformNoise(row.linking_domain));
  const rows = kept.map(row => ({ ...row, overlap: row.found_on.length }));
  return { ...metadata, returned: rows.length,
    priority_targets: rows.filter(row => row.overlap >= 2), secondary_targets: rows.filter(row => row.overlap < 2),
    sample_rows_considered: gaps.length, platforms_filtered: gaps.length - kept.length, filter_count_scope: "returned_backend_sample",
    authority_enriched: 0, enrichment_requested: requested, enrichment: [], research_only: true,
  };
}
async function enrich(call: ToolCall, result: OutreachResult): Promise<void> {
  if (result.enrichment_requested === 0) return;
  const pinned = result.provenance_status === "verified";
  const release = pinned ? directoryReleaseSchema.safeParse(result.release_id) : undefined;
  if (pinned && !release?.success) {
    call.partialErrors.push({ ...safeError("release_unavailable"), operation: "authority_enrichment" });
    return;
  }
  const targets = [...result.priority_targets, ...result.secondary_targets].slice(0, result.enrichment_requested);
  for (const target of targets) {
    if (call.signal.aborted || call.now() >= call.deadline) {
      call.partialErrors.push({ ...safeError(call.signal.aborted ? "cancelled" : "deadline_exceeded"),
        operation: "authority_enrichment", linking_domain: target.linking_domain });
      break;
    }
    const record: z.infer<typeof enrichmentSchema> = { linking_domain: target.linking_domain, status: "error",
      release_id: pinned ? result.release_id : null, provenance_scope: pinned ? "job_release" : "separate_lookup_release",
      cg_authority: null, cg_rank: null, error: null };
    result.enrichment.push(record);
    try {
      const reply = await call.execute({ operation: "backlinks", domain: target.linking_domain, limit: 1,
        ...(release?.success ? { release_id: release.data } : {}) });
      if (reply.operation !== "backlinks" || reply.status !== "complete" || !reply.data) {
        record.error = safeError(reply.error?.code ?? "temporarily_unavailable");
      } else {
        record.release_id = reply.data.release_id;
        record.cg_authority = reply.data.cg_authority;
        record.cg_rank = reply.data.cg_rank;
        record.status = record.cg_authority === null && record.cg_rank === null ? "unavailable"
          : record.cg_authority === null || record.cg_rank === null ? "partial" : "complete";
        if (record.cg_authority !== null) target.cg_authority = record.cg_authority;
        if (record.cg_rank !== null) target.cg_rank = record.cg_rank;
        if (record.cg_authority !== null) result.authority_enriched++;
        if (record.status !== "complete") record.error = safeError("authority_unavailable");
      }
    } catch (error) { record.error = safeError(error instanceof BackendExecutionError ? error.code : "temporarily_unavailable"); }
    if (record.error) {
      call.partialErrors.push({ ...record.error, operation: "authority_enrichment", linking_domain: target.linking_domain });
      // A later lookup must never hide a failure or retry an uncertain charge.
      break;
    }
  }
}

type GapInput = z.infer<typeof gapInput>;
async function runGap(call: ToolCall, request: DirectoryEnvelope["request"], input: GapInput, purpose: z.infer<typeof purposeSchema>,
  outreach?: z.infer<typeof outreachInput>): Promise<DirectoryResult> {
  let jobId = input.job_id;
  let data: z.infer<typeof directoryJobSchema> | null = null;
  let status: DirectoryEnvelope["status"] = "pending";
  let error: SafeError | null = null;
  const pollController = new AbortController();
  const pollTimer = setTimeout(() => pollController.abort(), POLL_MS);
  const combined = combineSignals([call.signal, pollController.signal]);
  const pollEnd = call.started + POLL_MS;
  const command = { my_domain: input.my_domain, competitor_domains: input.competitor_domains, purpose, limit: input.limit };
  try {
    if (input.competitor_domains.includes(input.my_domain)) throw new BackendExecutionError("validation_error", false);
    let reply = await call.execute(jobId ? { operation: "gap_poll", ...command, job_id: jobId }
      : { operation: "gap_submit", ...command }, pollEnd, combined.signal);
    let delay = 1500;
    while (true) {
      if (reply.operation !== "gap_submit" && reply.operation !== "gap_poll") throw new BackendExecutionError("invalid_response", true);
      const replyData = reply.data ? { ...reply.data, ...(reply.data.error ? { error: safeError(reply.data.error.code) } : {}) } : null;
      jobId = replyData?.job_id ?? jobId;
      if (reply.status !== "pending") {
        error = reply.error ? safeError(reply.error.code) : null;
        const interruptedPoll = reply.operation === "gap_poll" && jobId && replyData?.status !== "failed" && reply.status === "error" && error &&
          ["temporarily_unavailable", "operation_failed", "internal_error", "rate_limited"].includes(error.code);
        // A failed status read does not establish that an existing job failed.
        // Keep its handle and last observed state instead of inviting another submission.
        status = interruptedPoll ? "pending" : reply.status;
        data = interruptedPoll ? replyData ?? data : replyData;
        break;
      }
      data = replyData;
      if (!jobId) throw new BackendExecutionError("invalid_response", true);
      const remaining = pollEnd - call.now();
      if (remaining <= delay || combined.signal.aborted) break;
      await abortable((call.options.wait ?? defaultWait)(Math.min(delay, remaining), combined.signal), combined.signal);
      if (call.now() >= pollEnd || combined.signal.aborted) break;
      reply = await call.execute({ operation: "gap_poll", ...command, job_id: jobId }, pollEnd, combined.signal);
      delay = Math.min(delay + 1000, 5000);
    }
  } catch (failure) {
    const code = pollController.signal.aborted && !call.signal.aborted ? "deadline_exceeded"
      : failure instanceof BackendExecutionError ? failure.code : "temporarily_unavailable";
    error = safeError(code);
    status = jobId && !["invalid_token", "insufficient_scope", "validation_error"].includes(code) ? "pending" : "error";
  } finally {
    clearTimeout(pollTimer);
    combined.cleanup();
  }
  const envelope: DirectoryEnvelope = { status, request: { ...request, ...(jobId ? { job_id: jobId } : {}) },
    ...(jobId ? { job_id: jobId, resume_advice: "Resume this same tool with job_id and the normalized request. Polling is uncharged; do not submit a replacement for a pending, stale or interrupted job." } : {}),
    data, error, ...call.accounting(),
  };
  if (outreach && status === "complete" && data?.result) {
    const targets = outreachResult(data.result, outreach.include_platforms, outreach.enrich_authority_top);
    envelope.data = { ...data, result: targets };
    const result = fitResult(makeResult(envelope), ENRICHMENT_RESERVE_BYTES);
    const retained = result.structuredContent.data;
    if (retained && "result" in retained && retained.result && "enrichment" in retained.result) {
      await enrich(call, retained.result);
      Object.assign(result.structuredContent, call.accounting());
      const challenge = authenticationChallenge(result.structuredContent);
      if (challenge) { result._meta["mcp/www_authenticate"] = [challenge]; result.isError = true; }
      const protectedDomains = new Set(retained.result.enrichment.map(item => item.linking_domain));
      return fitResult(result, 0, protectedDomains);
    }
  }
  return fitResult(makeResult(envelope));
}

export function buildDirectoryServer(context: ProtectedConnectorContext, backend: DirectoryBackend,
  options: DirectoryFactoryOptions): McpServer {
  const server = new McpServer({ name: "crawlgraph", version: options.version }, { capabilities: { resources: {}, prompts: {} } });
  server.server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
  server.server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));
  const annotations = (title: string, idempotentHint = false) => ({ title, readOnlyHint: true, destructiveHint: false, idempotentHint, openWorldHint: true });
  const security = { securitySchemes: [{ type: "oauth2", scopes: [CONNECTOR_SCOPE] }] };
  async function withinCall(request: DirectoryEnvelope["request"], sdkSignal: AbortSignal,
    run: (call: ToolCall) => Promise<DirectoryResult>): Promise<DirectoryResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TOOL_MS - RETURN_MARGIN_MS);
    const joined = combineSignals([context.signal, sdkSignal, controller.signal]);
    const call = new ToolCall(context, backend, joined.signal, options);
    try { return await run(call); }
    catch (error) {
      const envelope: DirectoryEnvelope = { status: "error", request, data: null,
        error: safeError(error instanceof BackendExecutionError ? error.code : "temporarily_unavailable"), ...call.accounting() };
      return fitResult(makeResult(envelope));
    } finally { clearTimeout(timer); joined.cleanup(); }
  }
  async function ordinary(call: ToolCall, request: DirectoryEnvelope["request"], command: ExecuteCommand): Promise<DirectoryResult> {
    const reply = await call.execute(command);
    let data: DirectoryEnvelope["data"] = reply.data;
    if (data && "comparison_available" in data && !data.comparison_available) data = { ...data, counts: null };
    let omitted = 0;
    if (data && "releases" in data && "limit" in request) {
      omitted = Math.max(0, data.releases.length - request.limit);
      data = { releases: data.releases.slice(0, request.limit) };
    }
    const result = makeResult({ status: reply.status, request, data, error: reply.error ? safeError(reply.error.code) : null, ...call.accounting() });
    if (omitted) {
      const meta = result._meta["crawlgraph/output"];
      meta.backend_returned.releases += omitted;
      meta.omitted_rows.releases = omitted;
      meta.output_capped = true;
    }
    return fitResult(result);
  }
  const backlinks = server.registerTool("backlinks", { title: "Backlink lookup", description:
    "Research referring domains observed in a named Common Crawl release and the target's own authority/rank from that snapshot. Costs one backlinks call. Lists default to 20, maximum 100; exact total, observed count, source cap and unknown totals remain distinct.",
    inputSchema: backlinksInput, outputSchema: directoryEnvelopeSchema.shape, annotations: annotations("Backlink lookup"), _meta: security },
  async (input, extra) => {
    const request = { tool: "backlinks" as const, ...input };
    return withinCall(request, extra.signal, call => ordinary(call, request, { operation: "backlinks", ...input }));
  });
  const changes = server.registerTool("backlink_changes", { title: "Backlink changes between releases", description:
    "Compare Common Crawl referring-domain observations. Defaults to the newest queryable release pair; costs one backlinks call. Each list defaults to 20, maximum 100. Unavailable comparison differs from zero changes; source-capped counts are lower bounds. Removed means not observed in the newer snapshot, without proof of live deletion.",
    inputSchema: changesInput, outputSchema: directoryEnvelopeSchema.shape, annotations: annotations("Backlink changes between releases"), _meta: security },
  async (input, extra) => {
    const request = { tool: "backlink_changes" as const, ...input };
    return withinCall(request, extra.signal, call => ordinary(call, request, { operation: "changes", ...input }));
  });
  const gap = server.registerTool("gap_analysis", { title: "Competitor backlink gap analysis", description:
    "Find observed domains linking to 1..5 competitors but not your domain. A new job costs one gap call; job_id resume and polls cost zero. Polls for at most 75 seconds within a 90-second call, then returns pending plus job_id. Lists default to 20, maximum 100; ranking and totals cover the backend's observed source cap, with persisted release provenance.",
    inputSchema: gapInput, outputSchema: directoryEnvelopeSchema.shape, annotations: annotations("Competitor backlink gap analysis"), _meta: security },
  async (input, extra) => {
    const request = { tool: "gap_analysis" as const, purpose: "gap_analysis" as const, ...input };
    return withinCall(request, extra.signal, call => runGap(call, request, input, "gap_analysis"));
  });
  const outreach = server.registerTool("gap_outreach_targets", { title: "Outreach target research", description:
    "Research candidates only; never sends messages or creates contacts. Uses 1..5 competitors, prioritizing multiple-competitor targets over single-competitor candidates while preserving backend rank order. A new job costs one gap call; resume/poll costs zero. Platform-filter counts describe only the returned backend sample. Lists default to 20, maximum 100. Explicit enrich_authority_top defaults to 0, maximum 5, costing up to five additional backlinks calls for returned targets; failures and actual/unknown consumption are reported. Pending jobs return a resumable handle.",
    inputSchema: outreachInput, outputSchema: directoryEnvelopeSchema.shape, annotations: annotations("Outreach target research"), _meta: security },
  async (input, extra) => {
    const request = { tool: "gap_outreach_targets" as const, purpose: "gap_outreach_targets" as const, ...input };
    return withinCall(request, extra.signal, call => runGap(call, request, input, "gap_outreach_targets", input));
  });
  const releases = server.registerTool("releases", { title: "Available Common Crawl releases", description:
    "List known Common Crawl releases and whether each local artifact is available for queries. No research quota is consumed. List defaults to 20, maximum 100; output capping is disclosed.",
    inputSchema: releasesInput, outputSchema: directoryEnvelopeSchema.shape, annotations: annotations("Available Common Crawl releases", true), _meta: security },
  async (input, extra) => {
    const request = { tool: "releases" as const, ...input };
    return withinCall(request, extra.signal, call => ordinary(call, request, { operation: "releases" }));
  });
  const tools = new Map<string, { name: ToolName; schema: z.AnyZodObject; tool: RegisteredTool }>([
    ["backlinks", { name: "backlinks", schema: backlinksInput, tool: backlinks }],
    ["backlink_changes", { name: "backlink_changes", schema: changesInput, tool: changes }],
    ["gap_analysis", { name: "gap_analysis", schema: gapInput, tool: gap }],
    ["gap_outreach_targets", { name: "gap_outreach_targets", schema: outreachInput, tool: outreach }],
    ["releases", { name: "releases", schema: releasesInput, tool: releases }],
  ]);
  function boundaryError(name: ToolName, code: SafeCode, started = false, input?: Record<string, unknown>): DirectoryResult {
    const uncertain: QuotaCategory[] = [];
    if (started) {
      if (name === "backlinks" || name === "backlink_changes" ||
        (name === "gap_outreach_targets" && typeof input?.enrich_authority_top === "number" && input.enrich_authority_top > 0)) uncertain.push("backlinks");
      if ((name === "gap_analysis" || name === "gap_outreach_targets") && !input?.job_id) uncertain.push("gap");
    }
    return fitResult(makeResult({ status: "error", request: { tool: name, invalid_input: !started }, data: null,
      error: safeError(code), partial_errors: [], quota: [], quota_consumed_known: { backlinks: 0, gap: 0 },
      quota_consumed: { backlinks: uncertain.includes("backlinks") ? "UNKNOWN" : 0, gap: uncertain.includes("gap") ? "UNKNOWN" : 0 },
      unknown_consumption_categories: uncertain,
    }));
  }
  // SDK validation errors precede tool callbacks and contain unbounded issue
  // text. Use the public protocol boundary so every directory result, including
  // invalid input, follows the advertised schema and complete byte budget.
  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const requestId = connectorRequestId();
    const began = performance.now();
    const entry = tools.get(request.params.name);
    const name = entry?.name ?? "unknown";
    let started = false;
    let input: Record<string, unknown> | undefined;
    let result: DirectoryResult | undefined;
    try {
      // Task-mode requests remain protocol errors: the SDK expects CreateTaskResult.
      if (request.params.task) throw new McpError(ErrorCode.MethodNotFound, "Task execution is not supported by these research tools.");
      if (!entry || !entry.tool.enabled) return result = boundaryError(name, "not_found");
      const parsed = entry.schema.safeParse(request.params.arguments ?? {});
      if (!parsed.success || typeof entry.tool.handler !== "function") return result = boundaryError(name, "validation_error");
      input = parsed.data;
      started = true;
      const reply = await (entry.tool.handler as ToolCallback<z.ZodRawShape>)(parsed.data, extra);
      return result = fitResult(resultSchema.parse(reply));
    } catch (error) {
      if (request.params.task) throw error;
      return result = boundaryError(name, "temporarily_unavailable", started, input);
    } finally {
      // Measure the exact final validated CallToolResult, after all clipping and
      // accounting, excluding transport framing. Cleanup stays inside withinCall.
      try {
        const envelope = result?.structuredContent;
        logConnectorTelemetry({ event: "connector_tool", request_id: requestId, tool: name,
          status: envelope?.status ?? "error", isError: result?.isError === true || !result,
          code: envelope?.error?.code ?? (result ? null : "method_not_allowed"),
          latency_ms: Math.max(0, Math.round(performance.now() - began)),
          result_bytes: result ? Buffer.byteLength(JSON.stringify(result), "utf8") : 0,
          known_charged_calls: envelope ? envelope.quota_consumed_known.backlinks + envelope.quota_consumed_known.gap : 0,
          unknown_consumption_categories: envelope?.unknown_consumption_categories ?? [],
          partial_codes: envelope?.partial_errors.map(error => error.code) ?? [],
        });
      } catch { /* Logging cannot replace a completed result or protocol error. */ }
    }
  });
  return server;
}
