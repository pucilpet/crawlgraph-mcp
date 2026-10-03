import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildDirectoryServer } from "../dist/server.js";
import { BackendClient, verifiedIngress } from "../dist/backend-client.js";

// These are Node/SDK adapter tests. Fake RPC replies do not establish SQLite
// atomicity, ownership enforcement, query ranking or pinned DuckDB execution;
// the separate crawlback backend HTTP tests own those assertions.
const SECRET = ["connector-test-service-secret-", "s".repeat(40)].join("");
const TOKEN = ["cgc_access_", "a".repeat(43)].join("");
const SECOND_TOKEN = ["cgc_access_", "b".repeat(43)].join("");
const RESOURCE = "https://crawlgraph.com/mcp/connectors";
const SOURCE = "203.0.113.8";
const RESET = "2026-11-01T00:00:00Z";
const CAVEAT = "Periodic Common Crawl observations do not prove live links.";
const QUERY = { my_domain: "mine.example", competitor_domains: ["a.example", "b.example"] };
const TITLES = {
  backlinks: "Backlink lookup", backlink_changes: "Backlink changes between releases",
  gap_analysis: "Competitor backlink gap analysis", gap_outreach_targets: "Outreach target research",
  releases: "Available Common Crawl releases",
};
const TOOL_CODES = new Set(["invalid_token", "insufficient_scope", "temporarily_unavailable", "invalid_response",
  "cancelled", "deadline_exceeded", "validation_error", "quota_exceeded", "upgrade_required", "release_unavailable",
  "not_found", "job_stale", "operation_failed", "internal_error", "rate_limited", "authority_unavailable", "method_not_allowed"]);
function toolTelemetry(line, result, expectedTool) {
  const record = JSON.parse(line);
  assert.deepEqual(Object.keys(record).sort(), ["event", "request_id", "tool", "status", "isError", "code",
    "latency_ms", "result_bytes", "known_charged_calls", "unknown_consumption_categories", "partial_codes"].sort());
  assert.equal(record.event, "connector_tool");
  assert.match(record.request_id, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  assert.ok([...Object.keys(TITLES), "unknown"].includes(record.tool));
  assert.equal(record.tool, expectedTool);
  assert.ok(["complete", "pending", "unavailable", "error"].includes(record.status));
  assert.equal(record.status, result.structuredContent.status);
  assert.equal(record.isError, result.isError === true);
  assert.ok(record.code === null || TOOL_CODES.has(record.code));
  assert.equal(record.code, result.structuredContent.error?.code ?? null);
  assert.ok(Number.isSafeInteger(record.latency_ms) && record.latency_ms >= 0);
  assert.equal(record.result_bytes, Buffer.byteLength(JSON.stringify(result), "utf8"));
  assert.ok(record.result_bytes > 0 && record.result_bytes <= 65536);
  assert.ok(Number.isInteger(record.known_charged_calls) && record.known_charged_calls >= 0 && record.known_charged_calls <= 6);
  assert.equal(record.known_charged_calls, result.structuredContent.quota_consumed_known.backlinks + result.structuredContent.quota_consumed_known.gap);
  assert.ok(record.unknown_consumption_categories.length <= 2);
  assert.ok(record.unknown_consumption_categories.every(value => ["backlinks", "gap"].includes(value)));
  assert.deepEqual(record.unknown_consumption_categories, result.structuredContent.unknown_consumption_categories);
  assert.ok(record.partial_codes.length <= 8 && record.partial_codes.every(code => TOOL_CODES.has(code)));
  assert.deepEqual(record.partial_codes, result.structuredContent.partial_errors.map(error => error.code));
  return record;
}
const quota = (kind, used = 1) => ({ kind, used, limit: kind === "gap" ? 50 : 1000, resets_at: RESET });
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", ...headers },
});
function reply(operation, data, { status = "complete", error = null, consumed, quotas } = {}) {
  const category = operation === "backlinks" || operation === "changes" ? "backlinks"
    : operation === "gap_submit" ? "gap" : null;
  const count = consumed ?? (category ? 1 : 0);
  return { operation, status, data, error, quota: quotas ?? (category ? [quota(category)] : []),
    quota_consumed: { category: count ? category : null, count } };
}
function backlinks(command, overrides = {}) {
  return { domain: command.domain, release_id: command.release_id ?? "cc-a", release_label: "Snapshot A",
    total_linking_domains: 0, returned: 0, cg_authority: 80, cg_rank: 10, results: [],
    total: 0, observed: 0, total_is_lower_bound: false, cap: command.limit, source_cap: 100000,
    truncated: false, query_ms: 1, query_status: "complete", limitation_status: "complete",
    snapshot_caveat: CAVEAT, ...overrides };
}
function changes(command, overrides = {}) {
  return { domain: command.domain, comparison_available: true,
    from_release: { id: "cc-old", label: "Old" }, to_release: { id: "cc-a", label: "A" },
    counts: { from_snapshot: 0, to_snapshot: 0, added: 0, removed: 0, authority_moved: 0 },
    added: [], removed: [], authority_moved: [], truncated: false, cap: 100000,
    snapshot_caveat: CAVEAT, returned: { added: 0, removed: 0, authority_moved: 0 },
    result_cap: command.limit, source_truncated: false, total_is_lower_bound: false,
    query_status: "complete", ...overrides };
}
function gap(command, rows = [], overrides = {}) {
  return { my_domain: command.my_domain, competitor_domains: command.competitor_domains,
    gaps: rows, total_gaps: rows.length, truncated: false, release_id: "cc-a", provenance_status: "verified",
    built_at: "2026-10-01T00:00:00Z", returned: rows.length, total_observed: rows.length,
    total_is_lower_bound: false, limited: false, cap: 25000, result_cap: command.limit,
    query_ms: 2, linked: false, query_status: "complete", snapshot_caveat: CAVEAT, ...overrides };
}
function row(domain, found = QUERY.competitor_domains, authority = 80) {
  return { linking_domain: domain, found_on: found, num_hosts: 1, cg_authority: authority };
}
const completed = (result, job_id = "job-a") => ({ job_id, status: "completed", result });
const pending = (job_id = "job-a") => ({ job_id, status: "running", progress_pct: 25, result: null });
function ingress() {
  return verifiedIngress({ socket: { remoteAddress: "127.0.0.1" },
    rawHeaders: ["X-Forwarded-For", SOURCE], headers: { "x-forwarded-for": SOURCE } }, new Set(["127.0.0.1"]));
}
async function fixture(t, responder, { token = TOKEN, user = 1, controller = new AbortController(), now, wait, execute } = {}) {
  const requests = [];
  const backend = new BackendClient(SECRET, async (input, init) => {
    const request = { url: String(input), headers: new Headers(init.headers), command: JSON.parse(init.body), signal: init.signal };
    requests.push(request);
    assert.equal(request.url, "http://backend:8000/internal/mcp/operations/execute");
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    assert.equal(request.headers.get("x-crawlgraph-service-token"), SECRET);
    assert.equal(request.headers.get("authorization"), `Bearer ${token}`);
    assert.equal(request.command.source, SOURCE);
    assert.equal(request.command.source_verified, true);
    assert.equal(Object.hasOwn(request.command, "user_id"), false);
    assert.equal(Object.hasOwn(request.command, "token"), false);
    const result = await responder(request.command, request, requests.length);
    return result instanceof Response ? result : json(result);
  });
  const context = { auth: { token, clientId: `client-${user}`, scopes: ["crawlgraph:read"], resource: new URL(RESOURCE),
    expiresAt: 4102444800, grant: { user_id: user, grant_id: `grant-${user}` } }, ingress: ingress(), signal: controller.signal };
  const server = buildDirectoryServer(context, execute ? { execute: (...args) => execute(backend, ...args) } : backend, { now, wait });
  const client = new Client({ name: "connector-contract-test", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  t.after(async () => { await client.close(); await server.close(); });
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 65536, "entire SDK CallToolResult incl text/structured/_meta must fit 64 KiB");
    assert.doesNotMatch(JSON.stringify(result), new RegExp(`${TOKEN}|${SECOND_TOKEN}|${SECRET}`));
    return result;
  };
  return { client, call, requests, controller, context };
}
const envelope = result => result.structuredContent;
const output = result => result._meta["crawlgraph/output"];
function accounting(result, backlinksCount, gapCount) {
  assert.deepEqual(envelope(result).quota_consumed, { backlinks: backlinksCount, gap: gapCount });
}

test("directory advertises all five schemas, titles, OAuth scope and accurate metered annotations", async t => {
  const f = await fixture(t, () => assert.fail("discovery must not execute research"));
  const { tools } = await f.client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), Object.keys(TITLES).sort());
  for (const tool of tools) {
    assert.equal(tool.title, TITLES[tool.name]);
    assert.deepEqual(tool.annotations, { title: TITLES[tool.name], readOnlyHint: true, destructiveHint: false,
      idempotentHint: tool.name === "releases", openWorldHint: true });
    assert.deepEqual(tool._meta.securitySchemes, [{ type: "oauth2", scopes: ["crawlgraph:read"] }]);
    assert.equal(tool.inputSchema.properties.limit.default, 20);
    assert.equal(tool.inputSchema.properties.limit.maximum, 100);
    assert.equal(tool.inputSchema.properties.limit.minimum, 1);
    assert.equal(tool.outputSchema.properties.quota_consumed.type, "object");
    assert.ok(tool.outputSchema.properties.partial_errors);
  }
  const outreach = tools.find(tool => tool.name === "gap_outreach_targets");
  assert.equal(outreach.inputSchema.properties.enrich_authority_top.default, 0);
  assert.equal(outreach.inputSchema.properties.enrich_authority_top.maximum, 5);
  assert.equal(outreach.inputSchema.properties.enrich_authority_top.minimum, 0);
  assert.match(outreach.description, /never sends/);
  assert.match(outreach.description, /additional backlinks calls/);
  for (const name of ["gap_analysis", "gap_outreach_targets"]) assert.ok(tools.find(tool => tool.name === name).inputSchema.properties.job_id);
  assert.deepEqual(await f.client.listResources(), { resources: [] });
  assert.deepEqual(await f.client.listPrompts(), { prompts: [] });
});

test("directory default20/max100, normalization and hostile arguments are observed at the SDK boundary", async t => {
  const f = await fixture(t, command => reply("backlinks", backlinks(command)));
  const first = await f.call("backlinks", { domain: "  EXAMPLE.COM  " });
  assert.equal(f.requests[0].command.domain, "example.com");
  assert.equal(f.requests[0].command.limit, 20);
  assert.equal(f.requests[0].command.sort, "authority");
  accounting(first, 1, 0);
  await f.call("backlinks", { domain: "example.com", limit: 100 });
  assert.equal(f.requests[1].command.limit, 100);
  for (const args of [{ limit: 101 }, { limit: 0 }, { domain: "https://example.com" }, { user_id: 99 },
    { endpoint: "https://evil.example" }, { token: TOKEN }, { domain: "界".repeat(300000) }]) {
    const result = await f.call("backlinks", { domain: "example.com", ...args });
    assert.equal(result.isError, true);
    assert.equal(envelope(result).error.code, "validation_error");
    accounting(result, 0, 0);
  }
  assert.equal(f.requests.length, 2);
});

for (const [label, fields] of [
  ["complete zero", {}],
  ["unknown total", { total: null, total_linking_domains: 0, limitation_status: "unknown_total" }],
  ["source capped lower bound", { total: null, total_linking_domains: 100000, observed: 100000,
    total_is_lower_bound: true, truncated: true, limitation_status: "source_capped" }],
]) test(`backlinks preserves ${label} independently of returned empty rows`, async t => {
  const f = await fixture(t, command => reply("backlinks", backlinks(command, fields)));
  const result = await f.call("backlinks", { domain: "example.com" });
  const data = envelope(result).data;
  for (const [key, value] of Object.entries(backlinks({ domain: "example.com", limit: 20 }, fields))) assert.deepEqual(data[key], value);
  assert.equal(envelope(result).status, "complete");
  accounting(result, 1, 0);
});

test("unavailable changes carry null counts and a reason; complete zero changes carry real zero counts", async t => {
  let available = false;
  const f = await fixture(t, command => reply("changes", changes(command, available ? {} : {
    comparison_available: false, from_release: null, query_status: "unavailable", message: "Two queryable artifacts are required",
  }), { status: available ? "complete" : "unavailable" }));
  const absent = await f.call("backlink_changes", { domain: "example.com" });
  assert.equal(envelope(absent).status, "unavailable");
  assert.equal(envelope(absent).data.counts, null);
  assert.match(envelope(absent).data.message, /Two queryable/);
  assert.match(absent.content[0].text, /not evidence of zero/);
  assert.notEqual(absent.isError, true);
  available = true;
  const zero = await f.call("backlink_changes", { domain: "example.com" });
  assert.equal(envelope(zero).status, "complete");
  assert.equal(envelope(zero).data.counts.added, 0);
  accounting(absent, 1, 0);
  accounting(zero, 1, 0);
});

test("maximum100 backlink rows and Unicode fields remain bounded with honest source-capped totals", async t => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ linking_domain: `${String(i).padStart(3, "0")}${"界".repeat(81)}`,
    num_hosts: 1, tld: "界".repeat(21), cg_authority: 50, cg_rank: i + 1 }));
  const f = await fixture(t, command => reply("backlinks", backlinks(command, {
    release_label: "界".repeat(80), snapshot_caveat: "界".repeat(300), results: rows, returned: 100,
    total_linking_domains: 100000, total: null, observed: 100000, total_is_lower_bound: true,
    truncated: true, limitation_status: "source_capped",
  })));
  const result = await f.call("backlinks", { domain: "example.com", limit: 100 });
  assert.equal(envelope(result).status, "complete");
  assert.deepEqual(envelope(result).data.results, rows);
  assert.equal(envelope(result).data.observed, 100000);
  assert.equal(envelope(result).data.total, null);
  assert.equal(envelope(result).data.total_is_lower_bound, true);
  assert.equal(envelope(result).data.source_cap, 100000);
  assert.equal(envelope(result).data.cap, 100);
  assert.equal(envelope(result).data.truncated, true);
  assert.deepEqual(output(result).backend_returned, { results: 100 });
  accounting(result, 1, 0);
});

test("maximum change lists with Unicode fields clip deterministically and retain original totals/caps/quota", async t => {
  const logs = [];
  t.mock.method(console, "error", line => logs.push(line));
  const domains = Array.from({ length: 100 }, (_, i) => `${String(i).padStart(3, "0")}${"界".repeat(81)}`);
  const f = await fixture(t, command => reply("changes", changes(command, {
    counts: { from_snapshot: 100000, to_snapshot: 100000, added: 1000, removed: 900, authority_moved: 800 },
    added: domains.map(linking_domain => ({ linking_domain, num_hosts: 1, cg_authority: 50 })),
    removed: domains.map(linking_domain => ({ linking_domain, num_hosts: 1, cg_authority: 40 })),
    authority_moved: domains.map(linking_domain => ({ linking_domain, from_authority: 40, to_authority: 50, delta: 10 })),
    returned: { added: 100, removed: 100, authority_moved: 100 }, source_truncated: true, total_is_lower_bound: true,
  })));
  const result = await f.call("backlink_changes", { domain: "example.com", limit: 100 });
  assert.equal(envelope(result).status, "complete");
  assert.deepEqual(await f.call("backlink_changes", { domain: "example.com", limit: 100 }), result);
  assert.equal(logs.length, 2);
  for (const line of logs) toolTelemetry(line, result, "backlink_changes");
  const data = envelope(result).data;
  assert.deepEqual(data.counts, { from_snapshot: 100000, to_snapshot: 100000, added: 1000, removed: 900, authority_moved: 800 });
  assert.equal(data.cap, 100000);
  assert.equal(data.result_cap, 100);
  assert.equal(data.source_truncated, true);
  assert.equal(data.total_is_lower_bound, true);
  assert.equal(data.from_release.id, "cc-old");
  assert.equal(data.to_release.id, "cc-a");
  assert.equal(data.truncated, true);
  assert.equal(output(result).output_capped, true);
  assert.deepEqual(output(result).backend_returned, { added: 100, removed: 100, authority_moved: 100 });
  for (const key of ["added", "removed", "authority_moved"]) {
    assert.equal(data.returned[key], data[key].length);
    assert.equal(output(result).omitted_rows[key], 100 - data[key].length);
    assert.deepEqual(data[key].map(item => item.linking_domain), domains.slice(0, data[key].length));
  }
  accounting(result, 1, 0);
});

test("release inventory is free and reports backend maximum1000 and displayed20/100 without charging", async t => {
  const releases = Array.from({ length: 1000 }, (_, i) => ({ id: `cc-${i}`, label: `Release ${i}`, available: i % 2 === 0 }));
  const f = await fixture(t, () => reply("releases", { releases }));
  for (const limit of [undefined, 100]) {
    const result = await f.call("releases", limit === undefined ? {} : { limit });
    assert.deepEqual(envelope(result).data.releases, releases.slice(0, limit ?? 20));
    assert.deepEqual(output(result).backend_returned, { releases: 1000 });
    assert.deepEqual(output(result).omitted_rows, { releases: 1000 - (limit ?? 20) });
    assert.equal(output(result).output_capped, true);
    accounting(result, 0, 0);
    assert.deepEqual(envelope(result).unknown_consumption_categories, []);
  }
});

test("gap submits once, polls within75s and persists pending job; fresh grant resumes without a charged submit", async t => {
  let milliseconds = 0;
  const waits = [];
  const responder = command => reply(command.operation, pending(), { status: "pending", quotas: [quota("gap", 7)] });
  const f = await fixture(t, responder, { now: () => milliseconds, wait: async duration => { waits.push(duration); milliseconds += duration; } });
  const result = await f.call("gap_analysis", { my_domain: "  MINE.EXAMPLE ", competitor_domains: ["B.EXAMPLE", "a.example", "a.example"] });
  assert.equal(envelope(result).status, "pending");
  assert.equal(envelope(result).job_id, "job-a");
  assert.equal(envelope(result).data.job_id, "job-a");
  assert.deepEqual(envelope(result).request.competitor_domains, QUERY.competitor_domains);
  assert.equal(f.requests.filter(request => request.command.operation === "gap_submit").length, 1);
  assert.ok(f.requests.length > 2);
  assert.ok(milliseconds <= 75000);
  assert.ok(milliseconds + waits.at(-1) >= 70000, "exercise the polling budget, without wall-clock waits");
  assert.ok(milliseconds < 90000);
  for (const request of f.requests) {
    assert.equal(request.command.purpose, "gap_analysis");
    assert.equal(request.command.my_domain, QUERY.my_domain);
    assert.deepEqual(request.command.competitor_domains, QUERY.competitor_domains);
    if (request.command.operation === "gap_poll") assert.equal(request.command.job_id, "job-a");
  }
  accounting(result, 0, 1);
  assert.match(envelope(result).resume_advice, /do not submit a replacement/);
  const resumed = await fixture(t, command => reply("gap_poll", completed(gap(command)), { quotas: [quota("gap", 7)] }), { token: SECOND_TOKEN });
  const done = await resumed.call("gap_analysis", { ...QUERY, job_id: "job-a" });
  assert.equal(envelope(done).status, "complete");
  assert.equal(resumed.requests.length, 1);
  assert.equal(resumed.requests[0].command.operation, "gap_poll");
  accounting(done, 0, 0);
  assert.equal(envelope(done).data.result.release_id, "cc-a");
});

test("poll deadline uses remaining absolute budget and retains accepted submission when a poll times out", async t => {
  let milliseconds = 0;
  const timeouts = [];
  const f = await fixture(t, command => reply(command.operation, pending(), { status: "pending" }), {
    now: () => milliseconds, wait: async () => { milliseconds = 74900; },
    execute: async (backend, command, ...args) => {
      timeouts.push(args.at(-1));
      const result = await backend.execute(command, ...args);
      if (command.operation === "gap_poll") { milliseconds += 100; throw new Error("Lost uncharged status read"); }
      return result;
    },
  });
  const result = await f.call("gap_analysis", QUERY);
  assert.deepEqual(timeouts, [15000, 100]);
  assert.equal(milliseconds, 75000);
  assert.equal(envelope(result).status, "pending");
  assert.equal(envelope(result).job_id, "job-a");
  assert.equal(f.requests.length, 2);
  accounting(result, 0, 1);
});

test("cancellation after accepted submission stops additional polls and preserves actual charge and handle", async t => {
  const controller = new AbortController();
  const f = await fixture(t, command => reply(command.operation, pending(), { status: "pending" }), {
    controller, now: () => 0, wait: async () => { controller.abort(); },
  });
  const result = await f.call("gap_analysis", QUERY);
  assert.equal(f.requests.length, 1);
  assert.equal(envelope(result).status, "pending");
  assert.equal(envelope(result).error.code, "cancelled");
  assert.equal(envelope(result).job_id, "job-a");
  accounting(result, 0, 1);
});

test("pending gap leaves only the remaining whole-call budget for enrichment and stops further charged work", async t => {
  let milliseconds = 0;
  const timeouts = [];
  const f = await fixture(t, command => {
    if (command.operation === "gap_submit") return reply("gap_submit", pending(), { status: "pending" });
    if (command.operation === "gap_poll") return reply("gap_poll", completed(gap(command,
      [row("first.example"), row("second.example")])));
    milliseconds = 88000;
    return reply("backlinks", backlinks(command), { quotas: [quota("backlinks", 10)] });
  }, { now: () => milliseconds, wait: async () => { milliseconds = 74000; },
    execute: (backend, command, ...args) => { timeouts.push(args.at(-1)); return backend.execute(command, ...args); } });
  const result = await f.call("gap_outreach_targets", { ...QUERY, enrich_authority_top: 2 });
  assert.deepEqual(timeouts, [15000, 1000, 14000]);
  assert.equal(f.requests.length, 3);
  assert.equal(envelope(result).status, "complete");
  assert.equal(envelope(result).data.result.enrichment.length, 1);
  assert.equal(envelope(result).data.result.enrichment[0].status, "complete");
  assert.equal(envelope(result).partial_errors[0].code, "deadline_exceeded");
  assert.equal(envelope(result).partial_errors[0].linking_domain, "second.example");
  assert.ok(milliseconds < 90000);
  accounting(result, 1, 1);
});

test("lost poll response keeps a charged pending job and never marks another gap charge unknown", async t => {
  const f = await fixture(t, command => {
    if (command.operation === "gap_poll") throw new Error("Lost uncharged poll response");
    return reply("gap_submit", pending(), { status: "pending" });
  }, { now: () => 0, wait: async () => {} });
  const result = await f.call("gap_analysis", QUERY);
  assert.equal(f.requests.length, 2);
  assert.equal(envelope(result).status, "pending");
  assert.equal(envelope(result).job_id, "job-a");
  assert.equal(envelope(result).data.job_id, "job-a");
  accounting(result, 0, 1);
  assert.deepEqual(envelope(result).unknown_consumption_categories, []);
  assert.equal(result._meta["mcp/www_authenticate"], undefined);
});

for (const code of ["job_stale", "operation_failed", "temporarily_unavailable", "not_found"]) {
  test(`resume forwards purpose/query/handle on ${code} and never resubmits`, async t => {
    const f = await fixture(t, command => reply(command.operation, null, {
      status: "error", consumed: 0, error: { code, message: "Backend policy rejected this poll" }, quotas: [quota("gap", 8)],
    }));
    const result = await f.call("gap_outreach_targets", { ...QUERY, job_id: "job-a" });
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].command.operation, "gap_poll");
    assert.equal(f.requests[0].command.purpose, "gap_outreach_targets");
    assert.equal(envelope(result).job_id, "job-a");
    assert.equal(envelope(result).error.code, code);
    accounting(result, 0, 0);
    assert.equal(result._meta["mcp/www_authenticate"], undefined);
  });
}

test("gap worker explicit postcharge HTTP503 retains consumed counter and latest quota without reauth", async t => {
  const f = await fixture(t, command => json(reply(command.operation, { job_id: "job-a", status: "failed", result: null,
    error: { code: "operation_failed", message: "Worker failed after admission" } }, {
    status: "error", error: { code: "operation_failed", message: "Worker failed after admission" }, quotas: [quota("gap", 12)],
  }), 503));
  const result = await f.call("gap_analysis", QUERY);
  assert.equal(result.isError, true);
  assert.equal(envelope(result).job_id, "job-a");
  accounting(result, 0, 1);
  assert.deepEqual(envelope(result).quota, [quota("gap", 12)]);
  assert.equal(result._meta["mcp/www_authenticate"], undefined);
  assert.equal(f.requests.length, 1);
});

for (const [kind, response] of [
  ["lost transport", () => { throw new Error(`lost ${TOKEN} ${SECRET}`); }],
  ["malformed JSON", () => new Response("{", { headers: { "content-type": "application/json" } })],
  ["oversized body", () => new Response("界".repeat(50000), { headers: { "content-type": "application/json" } })],
  ["oversized declared length", () => json({}, 200, { "content-length": "131073" })],
  ["invalid envelope", () => ({ operation: "gap_submit", status: "complete", data: {} })],
]) test(`${kind} after gap dispatch reports UNKNOWN consumption, never zero or automatic resubmission`, async t => {
  const f = await fixture(t, response);
  const result = await f.call("gap_analysis", QUERY);
  assert.equal(f.requests.length, 1);
  assert.equal(result.isError, true);
  accounting(result, 0, "UNKNOWN");
  assert.deepEqual(envelope(result).quota_consumed_known, { backlinks: 0, gap: 0 });
  assert.deepEqual(envelope(result).unknown_consumption_categories, ["gap"]);
  assert.equal(result._meta["mcp/www_authenticate"], undefined);
});

test("transport timeout is bounded with fake timers, records uncertain submission, and never retries", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let dispatch;
  const started = new Promise(resolve => { dispatch = resolve; });
  const f = await fixture(t, () => { dispatch(); return new Promise(() => {}); });
  const resultPromise = f.call("gap_analysis", QUERY);
  await started;
  t.mock.timers.tick(15000);
  const result = await resultPromise;
  assert.equal(f.requests.length, 1);
  assert.equal(envelope(result).error.code, "deadline_exceeded");
  accounting(result, 0, "UNKNOWN");
  t.mock.timers.reset();
});

test("precommit service503 has known zero consumption and no OAuth challenge", async t => {
  const f = await fixture(t, () => json({ error: "temporarily_unavailable" }, 503));
  const result = await f.call("gap_analysis", QUERY);
  assert.equal(envelope(result).error.code, "temporarily_unavailable");
  accounting(result, 0, 0);
  assert.equal(result._meta["mcp/www_authenticate"], undefined);
});

test("outreach preserves backend competitor/authority/domain ranking and sample-only filter counts", async t => {
  const rows = [row("z.example", QUERY.competitor_domains, 95), row("a.example", QUERY.competitor_domains, 90),
    row("b.example", QUERY.competitor_domains, 90), row("github.io", QUERY.competitor_domains, 80), row("single.example", ["a.example"], 100)];
  const f = await fixture(t, command => reply(command.operation, completed(gap(command, rows, {
    total_gaps: 25000, total_observed: 25000, truncated: true, limited: true, total_is_lower_bound: true,
  }))));
  const result = await f.call("gap_outreach_targets", QUERY);
  const data = envelope(result).data.result;
  assert.deepEqual(data.priority_targets.map(target => target.linking_domain), ["z.example", "a.example", "b.example"]);
  assert.deepEqual(data.secondary_targets.map(target => target.linking_domain), ["single.example"]);
  assert.equal(data.sample_rows_considered, 5);
  assert.equal(data.platforms_filtered, 1);
  assert.equal(data.filter_count_scope, "returned_backend_sample");
  assert.equal(data.total_gaps, 25000);
  assert.equal(data.returned, 4);
  assert.equal(data.research_only, true);
  assert.equal(data.enrichment_requested, 0);
  assert.deepEqual(data.enrichment, []);
  assert.equal(f.requests.length, 1);
  accounting(result, 0, 1);
  const included = await f.call("gap_outreach_targets", { ...QUERY, include_platforms: true });
  assert.equal(envelope(included).data.result.platforms_filtered, 0);
  assert.equal(envelope(included).data.result.returned, 5);
});

for (const requested of [0, 1, 2, 3, 4, 5]) test(`explicit outreach enrichment${requested} charges exactlyN and uses attested job release`, async t => {
  const rows = Array.from({ length: 5 }, (_, i) => row(`target-${i}.example`));
  const f = await fixture(t, command => command.operation === "backlinks"
    ? reply("backlinks", backlinks(command), { quotas: [quota("backlinks", 100)] })
    : reply(command.operation, completed(gap(command, rows)), { quotas: [quota("gap", 7)] }));
  const result = await f.call("gap_outreach_targets", { ...QUERY, enrich_authority_top: requested });
  assert.equal(f.requests.length, 1 + requested);
  for (const request of f.requests.slice(1)) {
    assert.equal(request.command.operation, "backlinks");
    assert.equal(request.command.limit, 1);
    assert.equal(request.command.release_id, "cc-a");
  }
  const data = envelope(result).data.result;
  assert.equal(data.authority_enriched, requested);
  assert.equal(data.enrichment.length, requested);
  assert.ok(data.enrichment.every(record => record.release_id === "cc-a" && record.provenance_scope === "job_release"));
  accounting(result, requested, 1);
});

test("outreach rejects implicit legacy enrich_top, over5, fractional and negative enrichment without dispatch", async t => {
  const f = await fixture(t, () => assert.fail("invalid request must not dispatch"));
  for (const options of [{ enrich_top: 1 }, { enrich_authority_top: 6 }, { enrich_authority_top: -1 }, { enrich_authority_top: 1.5 }]) {
    const result = await f.call("gap_outreach_targets", { ...QUERY, ...options });
    assert.equal(envelope(result).error.code, "validation_error");
    accounting(result, 0, 0);
  }
});

test("unknown legacy job keeps null provenance and records each separate enrichment release", async t => {
  const f = await fixture(t, command => command.operation === "backlinks"
    ? reply("backlinks", backlinks(command, { release_id: "cc-b" }))
    : reply(command.operation, completed(gap(command, [row("target.example")], {
      release_id: null, built_at: null, provenance_status: "legacy_unverified",
    }))));
  const result = await f.call("gap_outreach_targets", { ...QUERY, job_id: "job-a", enrich_authority_top: 1 });
  const data = envelope(result).data.result;
  assert.equal(data.release_id, null);
  assert.equal(data.built_at, null);
  assert.equal(data.provenance_status, "legacy_unverified");
  assert.equal(Object.hasOwn(f.requests[1].command, "release_id"), false);
  assert.equal(data.enrichment[0].release_id, "cc-b");
  assert.equal(data.enrichment[0].provenance_scope, "separate_lookup_release");
  accounting(result, 1, 0);
});

for (const lost of [false, true]) test(`later enrichment ${lost ? "lost response" : "explicit postcharge failure"} preserves completed result/provenance and latest accounting`, async t => {
  let lookups = 0;
  const f = await fixture(t, command => {
    if (command.operation !== "backlinks") return reply(command.operation, completed(gap(command,
      [row("first.example"), row("second.example"), row("third.example")])));
    if (++lookups === 1) return reply("backlinks", backlinks(command), { quotas: [quota("backlinks", 99)] });
    if (lost) throw new Error("Lost charged enrichment response");
    return reply("backlinks", null, { status: "error", error: { code: "quota_exceeded", message: "Already charged" },
      quotas: [quota("backlinks", 100)] });
  });
  const result = await f.call("gap_outreach_targets", { ...QUERY, enrich_authority_top: 3 });
  const data = envelope(result).data.result;
  assert.equal(envelope(result).status, "complete");
  assert.equal(data.priority_targets.length, 3);
  assert.equal(data.enrichment.length, 2);
  assert.equal(data.enrichment[0].status, "complete");
  assert.equal(data.enrichment[0].release_id, "cc-a");
  assert.equal(data.authority_enriched, 1);
  assert.equal(data.release_id, "cc-a");
  assert.equal(envelope(result).partial_errors.length, 1);
  assert.equal(envelope(result).partial_errors[0].linking_domain, "second.example");
  assert.equal(f.requests.length, 3);
  accounting(result, lost ? "UNKNOWN" : 2, 1);
  assert.equal(envelope(result).quota_consumed_known.backlinks, lost ? 1 : 2);
  assert.equal(envelope(result).quota.find(snapshot => snapshot.kind === "backlinks").used, lost ? 99 : 100);
  assert.equal(result._meta["mcp/www_authenticate"], undefined);
});

for (const outreach of [false, true]) test(`${outreach ? "partial outreach" : "gap"} huge bounded100 rows fit64K and retain job/provenance/source totals`, async t => {
  const longDomain = prefix => `${prefix}${"x".repeat(57)}.${"x".repeat(60)}.${"x".repeat(60)}.${"x".repeat(45)}.example`;
  const competitors = ["aaa", "bbb", "ccc"].map(longDomain);
  const rows = Array.from({ length: 100 }, (_, i) => row(longDomain(String(i).padStart(3, "0")), competitors));
  const query = { my_domain: "mine.example", competitor_domains: competitors, limit: 100 };
  let lookups = 0;
  const f = await fixture(t, command => {
    if (command.operation === "backlinks") {
      if (++lookups === 2) throw new Error("Lost later lookup response");
      return reply("backlinks", backlinks(command));
    }
    return reply(command.operation, completed(gap(command, rows, {
      total_gaps: 25000, total_observed: 25000, total_is_lower_bound: true, limited: true, truncated: true,
      snapshot_caveat: "界".repeat(300),
    })));
  });
  const result = await f.call(outreach ? "gap_outreach_targets" : "gap_analysis",
    { ...query, ...(outreach ? { enrich_authority_top: 5 } : {}) });
  assert.equal(envelope(result).status, "complete");
  assert.equal(envelope(result).job_id, "job-a");
  const data = envelope(result).data.result;
  assert.equal(data.release_id, "cc-a");
  assert.equal(data.built_at, "2026-10-01T00:00:00Z");
  assert.equal(data.total_gaps, 25000);
  assert.equal(data.total_observed, 25000);
  assert.equal(data.cap, 25000);
  assert.equal(data.result_cap, 100);
  assert.equal(data.truncated, true);
  assert.equal(data.total_is_lower_bound, true);
  assert.equal(output(result).output_capped, true);
  const key = outreach ? "priority_targets" : "gaps";
  assert.equal(output(result).backend_returned[key], 100);
  assert.ok(data.returned < 100);
  assert.equal(output(result).omitted_rows[key], 100 - data.returned);
  assert.deepEqual(data[key].map(item => item.linking_domain), rows.slice(0, data.returned).map(item => item.linking_domain));
  if (outreach) {
    assert.equal(data.enrichment.length, 2);
    assert.equal(data.enrichment[0].status, "complete");
    assert.equal(envelope(result).partial_errors.length, 1);
    accounting(result, "UNKNOWN", 1);
    assert.equal(envelope(result).quota_consumed_known.backlinks, 1);
  } else accounting(result, 0, 1);
});

for (const [limit, returned] of [[100, 101], [20, 21]]) {
  test(`private reply cannot expose rows over ${limit === 100 ? "schema maximum100" : "requested limit20"} or a full25k artifact`, async t => {
    const f = await fixture(t, command => reply(command.operation,
      completed(gap(command, Array.from({ length: returned }, (_, i) => row(`target-${i}.example`)), { total_gaps: 25000 }))));
    const result = await f.call("gap_analysis", { ...QUERY, limit });
    assert.equal(result.isError, true);
    assert.equal(envelope(result).data, null);
    assert.equal(envelope(result).error.code, "invalid_response");
    accounting(result, 0, "UNKNOWN");
  });
}

test("large credential-bearing error fields and invalid tool inputs return bounded safe SDK results", async t => {
  const logs = [];
  t.mock.method(console, "error", (...values) => logs.push(values.map(String).join(" ")));
  const f = await fixture(t, () => json({ error: "invalid_token", message: `${TOKEN}${SECRET}${"界".repeat(100000)}` }, 401));
  const malformed = await f.call("backlinks", { domain: "example.com" });
  assert.equal(envelope(malformed).error.code, "invalid_response");
  accounting(malformed, "UNKNOWN", 0);
  assert.equal(malformed._meta["mcp/www_authenticate"], undefined, "malformed backend auth body cannot create a relink challenge");
  const invalid = await f.call("unknown" + "界".repeat(100000), { arbitrary: TOKEN });
  assert.equal(envelope(invalid).error.code, "not_found");
  accounting(invalid, 0, 0);
  assert.equal(f.requests.length, 1);
  assert.equal(logs.length, 2);
  toolTelemetry(logs[0], malformed, "backlinks");
  toolTelemetry(logs[1], invalid, "unknown");
  assert.doesNotMatch(logs.join("\n"), new RegExp(`${TOKEN}|${SECRET}`));
});

test("two overlapping owners/grants have isolated execute headers, results and quota", async t => {
  let arrivals = 0;
  let release;
  const both = new Promise(resolve => { release = resolve; });
  const responder = owner => async command => {
    if (++arrivals === 2) release();
    await both;
    return reply("backlinks", backlinks(command, { cg_authority: owner === 1 ? 11 : 99 }), { quotas: [quota("backlinks", owner * 10)] });
  };
  const one = await fixture(t, responder(1));
  const two = await fixture(t, responder(2), { token: SECOND_TOKEN, user: 2 });
  const [a, b] = await Promise.all([one.call("backlinks", { domain: "one.example" }), two.call("backlinks", { domain: "two.example" })]);
  assert.equal(envelope(a).data.domain, "one.example");
  assert.equal(envelope(b).data.domain, "two.example");
  assert.equal(envelope(a).data.cg_authority, 11);
  assert.equal(envelope(b).data.cg_authority, 99);
  assert.deepEqual(envelope(a).quota, [quota("backlinks", 10)]);
  assert.deepEqual(envelope(b).quota, [quota("backlinks", 20)]);
  assert.equal(one.requests[0].headers.get("authorization"), `Bearer ${TOKEN}`);
  assert.equal(two.requests[0].headers.get("authorization"), `Bearer ${SECOND_TOKEN}`);
});

test("final tool telemetry covers success, cancelled pending, strict invalid replies, uncertain charges and partial revocation without private markers or stdout", async t => {
  const logs = [], stdout = [];
  t.mock.method(console, "error", (...values) => { assert.equal(values.length, 1); logs.push(values[0]); });
  t.mock.method(console, "log", (...values) => { stdout.push(values.map(String).join(" ")); });
  const domain = "private-target.example", job = "private-job-marker", argument = "private-argument-marker";
  const backendException = `private-backend-exception ${TOKEN} ${SECRET} ${domain} ${job} ${argument}`;
  const records = [];
  const check = async (f, name, args, expected = name) => {
    const before = logs.length;
    const result = await f.call(name, args);
    assert.equal(logs.length, before + 1, "one line at the final handler boundary");
    records.push(toolTelemetry(logs.at(-1), result, expected));
    return result;
  };
  const success = await fixture(t, command => reply("backlinks", backlinks(command, { release_label: "Unicode 界" })));
  const good = await check(success, "backlinks", { domain });
  assert.equal(records.at(-1).code, null);
  assert.equal(records.at(-1).known_charged_calls, 1);
  await check(success, "backlinks", { domain, arbitrary: argument });
  assert.equal(records.at(-1).code, "validation_error");
  await check(success, `${argument}-${TOKEN}`, { domain, job_id: job }, "unknown");
  assert.equal(records.at(-1).code, "not_found");
  const controller = new AbortController();
  const cancel = await fixture(t, command => reply(command.operation, pending(job), { status: "pending" }),
    { controller, now: () => 0, wait: async () => { controller.abort(); } });
  await check(cancel, "gap_analysis", { ...QUERY, my_domain: domain });
  assert.equal(records.at(-1).status, "pending");
  assert.equal(records.at(-1).isError, false);
  assert.equal(records.at(-1).code, "cancelled");
  assert.equal(records.at(-1).known_charged_calls, 1);
  const malformed = await fixture(t, command => ({ ...reply("backlinks", backlinks(command)), additive_private_field: backendException }));
  await check(malformed, "backlinks", { domain });
  assert.equal(records.at(-1).code, "invalid_response");
  assert.deepEqual(records.at(-1).unknown_consumption_categories, ["backlinks"]);
  const lost = await fixture(t, () => { throw new Error(backendException); });
  await check(lost, "gap_analysis", { ...QUERY, my_domain: domain });
  assert.equal(records.at(-1).status, "error");
  assert.equal(records.at(-1).code, "temporarily_unavailable");
  assert.deepEqual(records.at(-1).unknown_consumption_categories, ["gap"]);
  const revoked = await fixture(t, command => command.operation === "backlinks"
    ? json({ error: "invalid_token" }, 401)
    : reply(command.operation, completed(gap(command, [row(domain)]), job)));
  await check(revoked, "gap_outreach_targets", { ...QUERY, enrich_authority_top: 1 });
  assert.equal(records.at(-1).status, "complete");
  assert.equal(records.at(-1).isError, true);
  assert.equal(records.at(-1).code, null);
  assert.deepEqual(records.at(-1).partial_codes, ["invalid_token"]);
  assert.equal(records.at(-1).known_charged_calls, 1);
  assert.equal(new Set(records.map(record => record.request_id)).size, records.length);
  for (const marker of [TOKEN, SECOND_TOKEN, SECRET, domain, job, argument, backendException,
    SOURCE, "client-1", "grant-1", "Unicode 界", ...Object.values(QUERY).flat()]) {
    assert.equal(logs.join("\n").includes(marker), false, "private marker must not enter telemetry");
  }
  assert.deepEqual(stdout, []);
  t.mock.method(console, "error", () => { throw new Error(backendException); });
  const despiteLogger = await success.call("backlinks", { domain });
  assert.deepEqual(despiteLogger, good, "logger failure cannot alter the validated result");
});
