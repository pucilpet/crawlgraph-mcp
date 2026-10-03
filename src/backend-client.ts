import { isIP } from "node:net";
import { randomUUID } from "node:crypto";
import type { Request } from "express";
import { z } from "zod";

export const CONNECTOR_ISSUER = "https://crawlgraph.com";
export const CONNECTOR_RESOURCE = `${CONNECTOR_ISSUER}/mcp/connectors`;
export const CONNECTOR_SCOPE = "crawlgraph:read";

// Telemetry accepts only fixed protocol categories and bounded scalar fields.
// Never pass request bodies, backend replies or exceptions to this boundary.
export const connectorTelemetryCodeSchema = z.enum([
  "invalid_request", "invalid_client", "invalid_client_metadata", "invalid_grant", "invalid_scope",
  "invalid_target", "invalid_token", "insufficient_scope", "unauthorized_client", "access_denied",
  "unsupported_grant_type", "unsupported_response_type", "unsupported_token_type", "server_error",
  "temporarily_unavailable", "too_many_requests", "method_not_allowed", "invalid_response",
  "cancelled", "deadline_exceeded", "validation_error", "quota_exceeded", "upgrade_required",
  "release_unavailable", "not_found", "job_stale", "operation_failed", "internal_error",
  "rate_limited", "authority_unavailable", "missing_bearer", "untrusted_peer", "disabled",
]);
export const connectorStartupReasonSchema = z.enum([
  "Invalid CONNECTOR_ENABLED configuration", "Invalid CONNECTOR_SERVICE_SECRET configuration",
  "Invalid CONNECTOR_ISSUER configuration", "Invalid CONNECTOR_RESOURCE configuration",
  "Invalid CONNECTOR_SCOPE configuration", "Invalid CONNECTOR_REDIRECT_URIS configuration",
  "Invalid CONNECTOR_NGINX_PEER_IPS configuration", "Connector nginx peer verification unavailable",
  "Connector nginx peer configuration mismatch", "MCP_PATH conflicts with connector surface",
  "startup_failure", "started",
]);
const telemetryIdSchema = z.string().max(64).regex(/^(?:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|local-\d+)$/);
const telemetryCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const connectorTelemetrySchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("connector_tool"), request_id: telemetryIdSchema,
    tool: z.enum(["backlinks", "backlink_changes", "gap_analysis", "gap_outreach_targets", "releases", "unknown"]),
    status: z.enum(["complete", "pending", "unavailable", "error"]), isError: z.boolean(),
    code: connectorTelemetryCodeSchema.nullable(), latency_ms: telemetryCount,
    result_bytes: telemetryCount.max(65536), known_charged_calls: telemetryCount.max(6),
    unknown_consumption_categories: z.array(z.enum(["backlinks", "gap"])).max(2),
    partial_codes: z.array(connectorTelemetryCodeSchema).max(8),
  }).strict(),
  z.object({ event: z.literal("connector_http"), request_id: telemetryIdSchema,
    category: z.enum(["connector", "oauth_authorize", "oauth_token", "oauth_register", "oauth_revoke",
      "oauth_other", "authorization_metadata", "resource_metadata", "unknown"]),
    status: z.number().int().min(100).max(599), code: connectorTelemetryCodeSchema,
  }).strict(),
  z.object({ event: z.literal("connector_startup"), request_id: telemetryIdSchema,
    status: z.enum(["ready", "error"]), code: connectorStartupReasonSchema,
  }).strict(),
]);
export type ConnectorTelemetry = z.infer<typeof connectorTelemetrySchema>;
let fallbackTelemetryId = 0;
export function connectorRequestId(): string {
  try { return randomUUID(); }
  catch { return `local-${++fallbackTelemetryId}`; }
}
export function logConnectorTelemetry(event: ConnectorTelemetry): void {
  try {
    const parsed = connectorTelemetrySchema.safeParse(event);
    if (parsed.success) console.error(JSON.stringify(parsed.data));
  } catch { /* Observability failures must never change protocol behavior. */ }
}
const BACKEND_URL = "http://backend:8000/internal/mcp";
const AUTH_DEADLINE_MS = 3000;
const RESPONSE_LIMIT = 32 * 1024;
const sourceBrand = Symbol("verified nginx ingress");

export type VerifiedIngress = Readonly<{ source: string; [sourceBrand]: true }>;

export function normalizeIp(value: string): string | undefined {
  if (!isIP(value) || value.includes("%")) return undefined;
  if (isIP(value) === 4) return value;
  const host = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(host);
  if (!mapped) return host;
  const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function singleHeader(req: Request, name: string): string | undefined {
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === name) count++;
  }
  const value = req.headers[name];
  return count === 1 && typeof value === "string" ? value : undefined;
}

export function verifiedIngress(req: Request, trustedPeers: ReadonlySet<string>): VerifiedIngress | undefined {
  const peer = req.socket.remoteAddress && normalizeIp(req.socket.remoteAddress);
  if (!peer || !trustedPeers.has(peer)) return undefined;
  const forwarded = singleHeader(req, "x-forwarded-for");
  const source = forwarded && normalizeIp(forwarded.trim());
  if (!source) return undefined;
  return Object.freeze({ source, [sourceBrand]: true as const });
}

const boundedString = (max: number) => z.string().max(max).refine(value =>
  Buffer.byteLength(value, "utf8") <= max && !/[\x00-\x1f\x7f]/.test(value));
const opaqueId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const metadataUri = boundedString(2048).refine(value => value.length > 0);

export const publicClientMetadataSchema = z.object({
  redirect_uris: z.array(metadataUri).min(1).max(5),
  token_endpoint_auth_method: z.literal("none").default("none"),
  grant_types: z.array(z.enum(["authorization_code", "refresh_token"])).min(1).max(2)
    .refine(values => values.includes("authorization_code") && new Set(values).size === values.length)
    .default(["authorization_code", "refresh_token"]),
  response_types: z.tuple([z.literal("code")]).default(["code"]),
  scope: boundedString(256).default(CONNECTOR_SCOPE),
  client_name: boundedString(128).optional(),
  client_uri: metadataUri.optional(),
  logo_uri: metadataUri.optional(),
  tos_uri: metadataUri.optional(),
  policy_uri: metadataUri.optional(),
  contacts: z.array(boundedString(254)).max(5).optional(),
}).strict();

const clientSchema = publicClientMetadataSchema.extend({
  token_endpoint_auth_method: z.literal("none"),
  scope: z.literal(CONNECTOR_SCOPE),
  client_id: opaqueId,
  client_id_issued_at: timestamp,
}).strict();
const clientReplySchema = z.object({ client: clientSchema.nullable() }).strict();
const beginReplySchema = z.object({
  transaction_id: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  frontend_path: boundedString(256),
  expires_in: z.number().int().positive().max(2700),
}).strict();
const tokensSchema = z.object({
  access_token: z.string().regex(/^cgc_access_[A-Za-z0-9_-]{43,128}$/),
  refresh_token: z.string().regex(/^cgc_refresh_[A-Za-z0-9_-]{43,128}$/).optional(),
  expires_in: z.number().int().positive().max(600),
  scope: z.literal(CONNECTOR_SCOPE),
  token_type: z.literal("Bearer"),
}).strict();
const grantSchema = z.object({
  user_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  tier: z.enum(["free", "lifetime"]),
  auth_kind: z.enum(["account", "reviewer"]),
  grant_id: opaqueId, client_id: opaqueId, family_id: opaqueId,
  expires_at: timestamp, grant_expires_at: timestamp,
  resource: boundedString(2048),
  scopes: z.array(boundedString(256)).max(8),
}).strict();

export type PublicClientMetadata = z.infer<typeof publicClientMetadataSchema>;
export type BackendClientInformation = z.infer<typeof clientSchema>;
export type AuthorizationStart = z.infer<typeof beginReplySchema>;
export type ConnectorTokens = z.infer<typeof tokensSchema>;
export type ConnectorGrant = z.infer<typeof grantSchema>;
export type BeginAuthorization = {
  client_id: string; redirect_uri: string; resource: string; scopes: string[];
  code_challenge: string; code_challenge_method: "S256"; browser_nonce: string; state?: string;
};
export type CodeExchange = { client_id: string; code: string; verifier: string; redirect_uri?: string; resource: string };
export type RefreshExchange = { client_id: string; refresh_token: string; scopes?: string[]; resource?: string };

const errorCodes = z.enum([
  "invalid_request", "invalid_client", "invalid_client_metadata", "invalid_redirect_uri",
  "invalid_grant", "invalid_scope", "invalid_target", "unauthorized_client", "access_denied",
  "invalid_token", "insufficient_scope", "temporarily_unavailable", "rate_limited",
]);
export type BackendErrorCode = z.infer<typeof errorCodes>;

export class BackendRpcError extends Error {
  constructor(readonly code: BackendErrorCode, readonly retryAfter?: number) {
    super(code);
    this.name = "BackendRpcError";
  }
}

function unavailable(): BackendRpcError {
  return new BackendRpcError("temporarily_unavailable", 5);
}

export function validateServiceSecret(secret: string): void {
  if (secret.trim().length < 32 || secret.length > 512 || !/^[\x21-\x7e]+$/.test(secret)) {
    throw new Error("Invalid CONNECTOR_SERVICE_SECRET configuration");
  }
}

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const authority = count.max(100).nullable();
const rank = count.nullable();
const label = boundedString(256);
const domainName = boundedString(253).refine(value => value.length > 0);
const releaseId = z.string().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const directoryDomainSchema = z.string().trim().toLowerCase().min(1).max(253)
  .regex(/^[a-z0-9]([a-z0-9\-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9\-]{0,61}[a-z0-9])?)*\.[a-z]([a-z0-9\-]{0,61}[a-z0-9])?$/);
export const directoryReleaseSchema = z.string().trim().toLowerCase().pipe(releaseId);
export const directoryLimitSchema = z.number().int().min(1).max(100).default(20);
export const quotaSchema = z.object({
  kind: z.enum(["backlinks", "gap"]), used: count, limit: count, resets_at: boundedString(80),
}).strict();
export const operationErrorSchema = z.object({
  code: boundedString(64).refine(value => value.length > 0), message: boundedString(512),
  kind: z.enum(["backlinks", "gap"]).nullable().optional(),
  limit: count.nullable().optional(), used: count.nullable().optional(),
  resets_at: boundedString(80).nullable().optional(),
}).strict();
const backlinkRowSchema = z.object({
  linking_domain: domainName, num_hosts: count, tld: boundedString(63), cg_authority: authority, cg_rank: rank,
}).strict();
export const directoryBacklinksSchema = z.object({
  domain: domainName, release_id: releaseId, release_label: label,
  total_linking_domains: count, returned: count, cg_authority: authority, cg_rank: rank,
  results: z.array(backlinkRowSchema).max(100), total: count.nullable(), observed: count,
  total_is_lower_bound: z.boolean(), cap: count, source_cap: count, truncated: z.boolean(),
  query_ms: count.nullable(), query_status: z.literal("complete"),
  limitation_status: z.enum(["complete", "result_capped", "source_capped", "unknown_total"]),
  snapshot_caveat: boundedString(1024),
}).strict();
const changeReleaseSchema = z.object({ id: releaseId, label }).strict();
const observedRowSchema = z.object({ linking_domain: domainName, num_hosts: count, cg_authority: authority }).strict();
export const directoryChangesSchema = z.object({
  domain: domainName, comparison_available: z.boolean(), from_release: changeReleaseSchema.nullable(),
  to_release: changeReleaseSchema, message: boundedString(1024).nullable().optional(),
  counts: z.object({ from_snapshot: count, to_snapshot: count, added: count, removed: count, authority_moved: count }).strict(),
  added: z.array(observedRowSchema).max(100), removed: z.array(observedRowSchema).max(100),
  authority_moved: z.array(z.object({ linking_domain: domainName, from_authority: count.max(100),
    to_authority: count.max(100), delta: z.number().int().min(-100).max(100) }).strict()).max(100),
  truncated: z.boolean(), cap: count, snapshot_caveat: boundedString(1024),
  returned: z.object({ added: count, removed: count, authority_moved: count }).strict(),
  result_cap: count, source_truncated: z.boolean(), total_is_lower_bound: z.boolean(),
  query_status: z.enum(["complete", "unavailable"]),
}).strict();
export const directoryGapRowSchema = z.object({
  linking_domain: domainName, found_on: z.array(domainName).max(5), num_hosts: count, cg_authority: authority,
}).strict();
export const directoryGapResultSchema = z.object({
  my_domain: domainName, competitor_domains: z.array(domainName).min(1).max(5),
  gaps: z.array(directoryGapRowSchema).max(100), total_gaps: count, truncated: z.boolean(),
  release_id: z.string().max(128).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).nullable(), provenance_status: z.enum(["verified", "legacy_unverified"]),
  built_at: boundedString(80).nullable(), returned: count, total_observed: count,
  total_is_lower_bound: z.boolean(), limited: z.boolean(), cap: count, result_cap: count,
  query_ms: count.nullable(), linked: z.boolean().nullable(), query_status: z.literal("complete"),
  snapshot_caveat: boundedString(1024),
}).strict();
export const directoryJobSchema = z.object({
  job_id: opaqueId, status: z.enum(["queued", "running", "completed", "failed"]),
  progress_pct: count.max(100).nullable().optional(), started_at: boundedString(80).nullable().optional(),
  completed_at: boundedString(80).nullable().optional(), result: directoryGapResultSchema.nullable().optional(),
  error: operationErrorSchema.nullable().optional(),
}).strict();
export const directoryReleasesSchema = z.object({
  releases: z.array(z.object({ id: releaseId, label, available: z.boolean() }).strict()).max(1000),
}).strict();

const gapCommand = { my_domain: directoryDomainSchema, competitor_domains: z.array(directoryDomainSchema).min(1).max(5),
  purpose: z.enum(["gap_analysis", "gap_outreach_targets"]), limit: directoryLimitSchema };
const executeCommandSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("backlinks"), domain: directoryDomainSchema, limit: directoryLimitSchema,
    sort: z.enum(["authority", "hosts"]).default("authority"), release_id: directoryReleaseSchema.optional() }).strict(),
  z.object({ operation: z.literal("changes"), domain: directoryDomainSchema, limit: directoryLimitSchema,
    from_release: directoryReleaseSchema.optional(), to_release: directoryReleaseSchema.optional() }).strict(),
  z.object({ operation: z.literal("releases") }).strict(),
  z.object({ operation: z.literal("gap_submit"), ...gapCommand }).strict(),
  z.object({ operation: z.literal("gap_poll"), ...gapCommand, job_id: opaqueId }).strict(),
]);
export type ExecuteCommand = z.input<typeof executeCommandSchema>;
export type QuotaSnapshot = z.infer<typeof quotaSchema>;
export type QuotaCategory = QuotaSnapshot["kind"];
const replyShape = {
  status: z.enum(["complete", "pending", "unavailable", "error"]),
  error: operationErrorSchema.nullable(), quota: z.array(quotaSchema).max(2),
  quota_consumed: z.object({ category: z.enum(["backlinks", "gap"]).nullable(), count: z.union([z.literal(0), z.literal(1)]) }).strict(),
};
export const executionReplySchema = z.discriminatedUnion("operation", [
  z.object({ ...replyShape, operation: z.literal("backlinks"), data: directoryBacklinksSchema.nullable() }).strict(),
  z.object({ ...replyShape, operation: z.literal("changes"), data: directoryChangesSchema.nullable() }).strict(),
  z.object({ ...replyShape, operation: z.literal("releases"), data: directoryReleasesSchema.nullable() }).strict(),
  z.object({ ...replyShape, operation: z.literal("gap_submit"), data: directoryJobSchema.nullable() }).strict(),
  z.object({ ...replyShape, operation: z.literal("gap_poll"), data: directoryJobSchema.nullable() }).strict(),
]).superRefine((reply, context) => {
  const invalid = () => context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid execution envelope" });
  const category = reply.operation === "backlinks" || reply.operation === "changes" ? "backlinks"
    : reply.operation === "gap_submit" ? "gap" : null;
  if (new Set(reply.quota.map(quota => quota.kind)).size !== reply.quota.length) invalid();
  if (reply.quota_consumed.count === 0 && reply.quota_consumed.category !== null) invalid();
  if (reply.quota_consumed.count === 1 && reply.quota_consumed.category !== category) invalid();
  if (category === null && (reply.quota_consumed.count !== 0 || reply.quota_consumed.category !== null)) invalid();
  if (reply.status === "error") { if (!reply.error) invalid(); return; }
  if (!reply.data || reply.error) { invalid(); return; }
  if (category !== null && reply.quota_consumed.count !== 1) invalid();
  if (reply.operation === "gap_submit" || reply.operation === "gap_poll") {
    const job = reply.data;
    if (reply.status === "pending" ? !["queued", "running"].includes(job.status)
      : reply.status !== "complete" || job.status !== "completed" || !job.result) invalid();
    if (job.result && ((job.result.provenance_status === "legacy_unverified" &&
      (job.result.release_id !== null || job.result.built_at !== null)) ||
      (job.result.provenance_status === "verified" && job.result.release_id === null))) invalid();
  } else if (reply.operation === "changes") {
    if (reply.status !== (reply.data.comparison_available ? "complete" : "unavailable")) invalid();
    if (reply.data.query_status !== (reply.data.comparison_available ? "complete" : "unavailable")) invalid();
  } else if (reply.status !== "complete") invalid();
});
export type ExecutionReply = z.infer<typeof executionReplySchema>;

export class BackendExecutionError extends Error {
  constructor(readonly code: "invalid_token" | "insufficient_scope" | "temporarily_unavailable" | "cancelled" | "deadline_exceeded" | "invalid_response" | "validation_error",
    readonly consumptionUnknown: boolean) { super(code); this.name = "BackendExecutionError"; }
}

export class BackendClient {
  readonly #secret: string;
  readonly #fetch: typeof fetch;
  constructor(secret: string, fetchImplementation: typeof fetch = fetch) {
    validateServiceSecret(secret);
    this.#secret = secret;
    this.#fetch = fetchImplementation;
  }

  async #rpc<T>(path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, ingress: VerifiedIngress,
    command?: object, signal?: AbortSignal): Promise<T> {
    if (ingress[sourceBrand] !== true || !normalizeIp(ingress.source)) throw unavailable();
    const controller = new AbortController();
    const bounded = <V>(operation: Promise<V>): Promise<V> => new Promise((resolve, reject) => {
      const interrupted = () => reject(unavailable());
      if (controller.signal.aborted) { void operation.catch(() => {}); reject(unavailable()); return; }
      controller.signal.addEventListener("abort", interrupted, { once: true });
      operation.then(value => {
        controller.signal.removeEventListener("abort", interrupted);
        resolve(value);
      }, () => {
        controller.signal.removeEventListener("abort", interrupted);
        reject(unavailable());
      });
    });
    const abort = () => controller.abort();
    const deadline = setTimeout(abort, AUTH_DEADLINE_MS);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      // A lost response may follow a committed code exchange/refresh. Never retry.
      if (controller.signal.aborted) throw unavailable();
      const response = await bounded(this.#fetch(`${BACKEND_URL}${path}`, {
        method: command ? "POST" : "GET", redirect: "error", signal: controller.signal,
        headers: { "X-Crawlgraph-Service-Token": this.#secret, Accept: "application/json",
          ...(command ? { "Content-Type": "application/json" } : {}) },
        ...(command ? { body: JSON.stringify({ ...command, source: ingress.source, source_verified: true }) } : {}),
      }));
      if (response.redirected || response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw unavailable();
      const length = response.headers.get("content-length");
      if (length && (!/^\d+$/.test(length) || Number(length) > RESPONSE_LIMIT)) throw unavailable();
      if (!response.body) throw unavailable();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await bounded(reader.read());
          if (done) break;
          size += value.byteLength;
          if (size > RESPONSE_LIMIT) throw unavailable();
          chunks.push(value);
        }
      } finally {
        void reader.cancel().catch(() => {});
      }
      const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
      if (!response.ok) {
        if (response.status >= 500) throw unavailable();
        const parsed = z.object({ error: errorCodes }).strict().safeParse(body);
        if (!parsed.success) throw unavailable();
        if (response.status === 429 && parsed.data.error === "rate_limited") {
          const retry = response.headers.get("retry-after");
          if (!retry || !/^\d+$/.test(retry) || !Number.isSafeInteger(Number(retry))) throw unavailable();
          throw new BackendRpcError("rate_limited", Number(retry));
        }
        if (response.status !== 400 && response.status !== 401 && response.status !== 403) throw unavailable();
        if (parsed.data.error === "rate_limited" || parsed.data.error === "temporarily_unavailable") throw unavailable();
        throw new BackendRpcError(parsed.data.error);
      }
      const parsed = schema.safeParse(body);
      if (!parsed.success) throw unavailable();
      return parsed.data;
    } catch (error) {
      if (error instanceof BackendRpcError) throw error;
      throw unavailable();
    } finally {
      clearTimeout(deadline);
      signal?.removeEventListener("abort", abort);
      controller.abort();
    }
  }

  async getClient(clientId: string, ingress: VerifiedIngress, signal?: AbortSignal): Promise<BackendClientInformation | undefined> {
    // URL-shaped client IDs are opaque invalid IDs, never metadata documents.
    if (!opaqueId.safeParse(clientId).success) return undefined;
    const reply = await this.#rpc(`/clients/${encodeURIComponent(clientId)}`, clientReplySchema, ingress, undefined, signal);
    if (reply.client && reply.client.client_id !== clientId) throw unavailable();
    return reply.client ?? undefined;
  }
  async execute(command: ExecuteCommand, token: string, ingress: VerifiedIngress,
    signal?: AbortSignal, timeoutMs = 15_000): Promise<ExecutionReply> {
    let dispatched = false;
    let timedOut = false;
    const failure = (code: BackendExecutionError["code"] = "temporarily_unavailable") =>
      new BackendExecutionError(code, dispatched);
    if (ingress[sourceBrand] !== true || !normalizeIp(ingress.source)) throw failure();
    if (!/^cgc_access_[A-Za-z0-9_-]{43,128}$/.test(token)) throw new BackendExecutionError("invalid_token", false);
    const parsedCommand = executeCommandSchema.safeParse(command);
    if (!parsedCommand.success) throw failure("invalid_response");
    const input = parsedCommand.data;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw failure("deadline_exceeded");
    const controller = new AbortController();
    const abort = () => controller.abort();
    const deadlineAt = performance.now() + Math.min(15_000, timeoutMs);
    const deadline = setTimeout(() => { timedOut = true; abort(); }, Math.min(15_000, timeoutMs));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const interrupted = () => failure(timedOut ? "deadline_exceeded" : "cancelled");
    const assertActive = () => {
      if (performance.now() >= deadlineAt) { timedOut = true; abort(); }
      if (controller.signal.aborted) throw interrupted();
    };
    const bounded = <T>(operation: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
      const stop = () => reject(interrupted());
      if (controller.signal.aborted) { void operation.catch(() => {}); reject(interrupted()); return; }
      controller.signal.addEventListener("abort", stop, { once: true });
      operation.then(value => {
        controller.signal.removeEventListener("abort", stop);
        resolve(value);
      }, () => {
        controller.signal.removeEventListener("abort", stop);
        reject(failure());
      });
    });
    try {
      assertActive();
      dispatched = true;
      // The token is header-only; the fixed destination and principal resolution
      // cannot be selected by tool arguments. A lost charged response is never retried.
      const response = await bounded(this.#fetch(`${BACKEND_URL}/operations/execute`, {
        method: "POST", redirect: "error", signal: controller.signal,
        headers: { "X-Crawlgraph-Service-Token": this.#secret, Authorization: `Bearer ${token}`,
          Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, source: ingress.source, source_verified: true }),
      }));
      assertActive();
      const maxBytes = 128 * 1024;
      if (response.redirected || response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw failure("invalid_response");
      const length = response.headers.get("content-length");
      if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw failure("invalid_response");
      if (!response.body) throw failure("invalid_response");
      const reader = response.body.getReader();
      const buffer = new Uint8Array(maxBytes);
      let size = 0;
      try {
        while (true) {
          // Absolute checks also bound eagerly resolved/empty stream chunks
          // that can otherwise starve the timer queue. Storage stays fixed-size.
          assertActive();
          const { done, value } = await bounded(reader.read());
          assertActive();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) throw failure("invalid_response");
          buffer.set(value, size - value.byteLength);
        }
      } finally { void reader.cancel().catch(() => {}); }
      const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size)));
      assertActive();
      if (!response.ok) {
        const boundary = z.object({ error: z.enum(["invalid_token", "insufficient_scope", "invalid_service", "temporarily_unavailable"]) }).strict().safeParse(body);
        if (boundary.success) {
          const code = boundary.data.error;
          if ((code === "invalid_token" && response.status === 401) || (code === "insufficient_scope" && response.status === 403)) {
            throw new BackendExecutionError(code, false);
          }
          if ((code === "invalid_service" && response.status === 401) || (code === "temporarily_unavailable" && response.status === 503)) {
            throw new BackendExecutionError("temporarily_unavailable", false);
          }
        }
      }
      const parsed = executionReplySchema.safeParse(body);
      if (!parsed.success || parsed.data.operation !== input.operation || (!response.ok && parsed.data.status !== "error")) throw failure("invalid_response");
      const reply = parsed.data;
      if (reply.data) {
        if (reply.operation === "backlinks" && input.operation === "backlinks") {
          const data = reply.data;
          if (data.domain !== input.domain || (input.release_id && data.release_id !== input.release_id)
            || data.returned !== data.results.length || data.results.length > input.limit || data.cap !== input.limit
            || data.observed < data.returned || (data.total !== null && data.total < data.observed)) throw failure("invalid_response");
        } else if (reply.operation === "changes" && input.operation === "changes") {
          const data = reply.data;
          if (data.domain !== input.domain || (input.from_release && data.from_release?.id !== input.from_release)
            || (input.to_release && data.to_release.id !== input.to_release) || data.result_cap !== input.limit
            || (["added", "removed", "authority_moved"] as const).some(key =>
              data[key].length > input.limit || data.returned[key] !== data[key].length)) throw failure("invalid_response");
        } else if ((reply.operation === "gap_submit" || reply.operation === "gap_poll") &&
          (input.operation === "gap_submit" || input.operation === "gap_poll")) {
          const job = reply.data;
          if (input.operation === "gap_poll" && job.job_id !== input.job_id) throw failure("invalid_response");
          if (job.result) {
            const result = job.result;
            const competitors = [...new Set(input.competitor_domains)].sort();
            if (result.my_domain !== input.my_domain || JSON.stringify(result.competitor_domains) !== JSON.stringify(competitors)
              || result.returned !== result.gaps.length || result.gaps.length > input.limit || result.result_cap !== input.limit
              || result.total_observed < result.returned || result.total_gaps < result.returned
              || result.gaps.some(row => row.found_on.some(domain => !competitors.includes(domain)))) throw failure("invalid_response");
          }
        }
      }
      assertActive();
      return reply;
    } catch (error) {
      if (error instanceof BackendExecutionError) throw error;
      throw failure(controller.signal.aborted ? (timedOut ? "deadline_exceeded" : "cancelled") : "invalid_response");
    } finally {
      clearTimeout(deadline);
      signal?.removeEventListener("abort", abort);
      controller.abort();
    }
  }
  async registerClient(metadata: PublicClientMetadata, ingress: VerifiedIngress, signal?: AbortSignal): Promise<BackendClientInformation> {
    const reply = await this.#rpc("/clients/register", clientReplySchema, ingress, { metadata }, signal);
    if (!reply.client) throw unavailable();
    return reply.client;
  }
  beginAuthorization(command: BeginAuthorization, ingress: VerifiedIngress, signal?: AbortSignal): Promise<AuthorizationStart> {
    return this.#rpc("/authorizations/begin", beginReplySchema, ingress, command, signal);
  }
  exchangeCode(command: CodeExchange, ingress: VerifiedIngress, signal?: AbortSignal): Promise<ConnectorTokens> {
    return this.#rpc("/tokens/code", tokensSchema, ingress, command, signal);
  }
  exchangeRefresh(command: RefreshExchange, ingress: VerifiedIngress, signal?: AbortSignal): Promise<ConnectorTokens> {
    return this.#rpc("/tokens/refresh", tokensSchema, ingress, command, signal);
  }
  introspect(token: string, ingress: VerifiedIngress, signal?: AbortSignal): Promise<ConnectorGrant> {
    return this.#rpc("/tokens/introspect", grantSchema, ingress, { token }, signal);
  }
  async revoke(clientId: string, token: string, ingress: VerifiedIngress, signal?: AbortSignal): Promise<void> {
    await this.#rpc("/tokens/revoke", z.object({ status: z.literal("ok") }).strict(), ingress,
      { client_id: clientId, token }, signal);
  }
}
