import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildServer, VERSION } from "../dist/server.js";
import { createApp } from "../dist/http.js";

// Top-level tests run sequentially: the legacy adapter has no fetch injection.
// Never let a mock fall through to a live API; only the captured fetch below is
// used for explicitly constructed loopback HTTP requests.
const KEY = "cg_live_legacy_fixture";
const TOKEN = `cgc_access_${"x".repeat(43)}`;
const nativeFetch = globalThis.fetch;
const nativeSetTimeout = globalThis.setTimeout;
const json = payload => new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
const release = { id: "cc-old", label: "Old", available: true };
const backlink = {
  domain: "example.com", release_id: "cc-old", release_label: "Old",
  total_linking_domains: 1234, returned: 1, cg_authority: 77, cg_rank: 9,
  results: [{ linking_domain: "publisher.example", num_hosts: 2, tld: "example", cg_authority: null, cg_rank: null }],
};
const gapArgs = { my_domain: "example.com", competitor_domains: ["a.example", "b.example", "c.example"] };
const gap = {
  ...gapArgs, total_gaps: 4,
  gaps: [
    { linking_domain: "z.example", found_on: gapArgs.competitor_domains },
    { linking_domain: "a.example", found_on: gapArgs.competitor_domains },
    { linking_domain: "secondary.example", found_on: ["a.example", "b.example"] },
    { linking_domain: "blog.github.io", found_on: gapArgs.competitor_domains },
  ],
};

function capture(t, respond) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://crawlgraph.com");
    assert.ok(url.pathname.startsWith("/api/v1/"));
    const request = { url, method: init.method, headers: new Headers(init.headers),
      body: init.body === undefined ? undefined : JSON.parse(init.body) };
    requests.push(request);
    return json(await respond(request, requests.length));
  });
  return requests;
}

function publicRequest(request, path, method = "GET", key = KEY) {
  assert.equal(request.url.pathname + request.url.search, `/api/v1${path}`);
  assert.equal(request.method, method);
  assert.equal(request.headers.get("authorization"), `Bearer ${key}`);
  assert.equal(request.headers.get("content-type"), "application/json");
  assert.equal(request.headers.get("user-agent"), `crawlgraph-mcp/${VERSION}`);
  assert.doesNotMatch(JSON.stringify([...request.headers]), /cgc_access_/);
}

async function sdk(getKey, run) {
  const server = buildServer(getKey);
  const client = new Client({ name: "legacy-compat-fixture", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function output(result, expected, summary) {
  CallToolResultSchema.parse(result);
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, expected);
  assert.deepEqual(result.content, [
    ...(summary === undefined ? [] : [{ type: "text", text: summary }]),
    { type: "text", text: JSON.stringify(expected, null, 2) },
  ]);
  assert.equal(result._meta, undefined);
}

function fastLegacySleeps(t) {
  // A controlled timer seam for the legacy polling/enrichment sleeps only.
  // SDK request timeouts retain their real durations; source is unmodified.
  const sleeps = [];
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
    if ([250, 1500, 2500, 3500, 4500, 5000].includes(delay)) {
      sleeps.push(delay);
      return nativeSetTimeout(callback, 0, ...args);
    }
    return nativeSetTimeout(callback, delay, ...args);
  });
  return sleeps;
}

async function http(t, run) {
  const app = await createApp({ env: { CONNECTOR_ENABLED: "false" } });
  const listener = app.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const base = `http://127.0.0.1:${listener.address().port}`;
  try {
    await run(async (path, headers = {}, body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "releases", arguments: {} } }, method = "POST") => {
      return nativeFetch(`${base}${path}`, {
        method, headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
        ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
      });
    });
  } finally {
    await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  }
}

test("legacy SDK factory resolves its key lazily and advertises exactly the original five tools", async t => {
  const requests = capture(t, () => ({ releases: [release] }));
  let key = "";
  let resolutions = 0;
  await sdk(() => { resolutions++; return key; }, async client => {
    assert.equal(resolutions, 0);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), ["backlink_changes", "backlinks", "gap_analysis", "gap_outreach_targets", "releases"]);
    assert.deepEqual(await client.listResources(), { resources: [] });
    assert.deepEqual(await client.listPrompts(), { prompts: [] });
    assert.equal(resolutions, 0);
    const backlinks = tools.find(tool => tool.name === "backlinks");
    assert.equal(backlinks.inputSchema.properties.limit.maximum, 10000);
    assert.match(backlinks.inputSchema.properties.limit.description, /default 1000/);
    assert.ok(!backlinks.inputSchema.required.includes("limit"));
    const outreach = tools.find(tool => tool.name === "gap_outreach_targets");
    assert.equal(outreach.inputSchema.properties.enrich_top.maximum, 25);
    assert.match(outreach.inputSchema.properties.enrich_top.description, /Default 10/);
    assert.equal(outreach.inputSchema.properties.competitor_domains.minItems, 2);
    for (const tool of tools) {
      assert.ok(tool.outputSchema);
      assert.equal(tool.annotations.readOnlyHint, true);
      assert.equal(tool._meta?.securitySchemes, undefined);
    }
    const missing = await client.callTool({ name: "releases", arguments: {} });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /No CrawlGraph API key/);
    assert.equal(requests.length, 0);
    key = KEY;
    output(await client.callTool({ name: "releases", arguments: {} }), { releases: [release] });
    key = "cg_live_second_fixture";
    output(await client.callTool({ name: "releases", arguments: {} }), { releases: [release] });
    assert.equal(resolutions, 3);
    publicRequest(requests[0], "/releases");
    publicRequest(requests[1], "/releases", "GET", key);
  });
});

test("legacy backlinks preserves default omission, max 10000, optional selectors and exact output", async t => {
  const requests = capture(t, () => ({ ...backlink, private_extra: "discarded" }));
  await sdk(() => KEY, async client => {
    await client.listTools();
    const summary = "example.com — 1234 referring domains (release Old). Showing 1. Target authority: 77/100.";
    output(await client.callTool({ name: "backlinks", arguments: { domain: "example.com" } }), backlink, summary);
    assert.deepEqual(requests[0].body, { domain: "example.com" }); // Public API owns default 1000.
    output(await client.callTool({ name: "backlinks", arguments: { domain: "example.com", limit: 10000, sort: "hosts", release_id: "cc-old" } }), backlink, summary);
    assert.deepEqual(requests[1].body, { domain: "example.com", limit: 10000, sort: "hosts", release_id: "cc-old" });
    const rejected = await client.callTool({ name: "backlinks", arguments: { domain: "example.com", limit: 10001 } });
    assert.equal(rejected.isError, true);
    assert.equal(requests.length, 2);
    requests.forEach(request => publicRequest(request, "/backlinks", "POST"));
  });
});

for (const available of [true, false]) {
  test(`legacy changes preserves exact ${available ? "available" : "unavailable"} output and public query encoding`, async t => {
    const changes = { domain: "example.com", comparison_available: available,
      from_release: available ? { id: "cc-old", label: "Old" } : null,
      to_release: { id: "cc-new", label: "New" },
      counts: { from_snapshot: 0, to_snapshot: 0, added: 0, removed: 0, authority_moved: 0 },
      added: [], removed: [], authority_moved: [], truncated: false, cap: 100000, snapshot_caveat: "Snapshot observation." };
    const requests = capture(t, () => changes);
    await sdk(() => KEY, async client => {
      await client.listTools();
      const summary = `example.com: ${available ? "0 added, 0 removed, 0 authority moved" : "comparison unavailable"}. Default comparison is the newest queryable release pair. Costs one backlinks call. Removed domains mean not observed in the newer Common Crawl snapshot, not proven deletion from the live web. comparison_available: false is a valid response when two queryable snapshots do not exist.`;
      output(await client.callTool({ name: "backlink_changes", arguments: { domain: "example.com" } }), changes, summary);
      output(await client.callTool({ name: "backlink_changes", arguments: { domain: "example.com", from_release: "old/a b", to_release: "new?c" } }), changes, summary);
      publicRequest(requests[0], "/changes?domain=example.com");
      publicRequest(requests[1], "/changes?domain=example.com&from=old%2Fa+b&to=new%3Fc");
      assert.equal(requests[0].body, undefined);
    });
  });
}

test("legacy gap submits once, polls pending then completed, and retains the old result shape", async t => {
  const sleeps = fastLegacySleeps(t);
  const requests = capture(t, (_request, n) => n === 1 ? { job_id: "legacy-job" }
    : n === 2 ? { status: "running" } : { status: "completed", result: { ...gap, release_id: "ignored-additive-field" } });
  await sdk(() => KEY, async client => {
    await client.listTools();
    output(await client.callTool({ name: "gap_analysis", arguments: gapArgs }), gap,
      "4 gap domains link to a competitor but not to example.com (competitors: a.example, b.example, c.example).");
  });
  assert.deepEqual(requests[0].body, gapArgs);
  publicRequest(requests[0], "/gap-analysis", "POST");
  publicRequest(requests[1], "/gap-analysis/legacy-job");
  publicRequest(requests[2], "/gap-analysis/legacy-job");
  assert.deepEqual(sleeps, [1500, 2500]);
});

for (const enrichTop of [undefined, 0, 25]) {
  test(`legacy outreach preserves ${enrichTop === undefined ? "default 10" : enrichTop} enrichment and priority/secondary/platform semantics`, async t => {
    fastLegacySleeps(t);
    const competitors = gapArgs.competitor_domains;
    const priority = Array.from({ length: 26 }, (_, i) => ({ linking_domain: `p${String(i).padStart(2, "0")}.example`, found_on: competitors }));
    const data = { ...gap, total_gaps: 29, gaps: [...priority, ...gap.gaps.slice(2), { linking_domain: "single.example", found_on: ["a.example"] }] };
    const requests = capture(t, request => request.url.pathname.endsWith("/backlinks") ? { cg_authority: 60, cg_rank: 2 }
      : request.method === "POST" ? { job_id: "outreach-job" } : { status: "completed", result: data });
    const enriched = enrichTop === undefined ? 10 : enrichTop;
    const expected = { ...gapArgs, priority_targets: priority.map((row, i) => ({ ...row, overlap: 3,
      ...(i < enriched ? { cg_authority: 60, cg_rank: 2 } : {}) })),
      secondary_targets: [{ ...gap.gaps[2], overlap: 2 }], total_gaps: 29, platforms_filtered: 1, authority_enriched: enriched };
    await sdk(() => KEY, async client => {
      await client.listTools();
      output(await client.callTool({ name: "gap_outreach_targets", arguments: { ...gapArgs,
        ...(enrichTop === undefined ? {} : { enrich_top: enrichTop }) } }), expected,
      `26 PRIORITY targets (link to all 3 competitors but not example.com), 1 secondary (link to 2+). 1 platform/CDN domains filtered out. ${enriched ? `Top ${enriched} scored by authority. ` : ""}Pitch the priority list first — they already link to your whole category.`);
      const rejected = await client.callTool({ name: "gap_outreach_targets", arguments: { ...gapArgs, enrich_top: 26 } });
      assert.equal(rejected.isError, true);
    });
    assert.equal(requests.length, 2 + enriched);
    publicRequest(requests[0], "/gap-analysis", "POST");
    assert.deepEqual(requests[0].body, gapArgs);
    publicRequest(requests[1], "/gap-analysis/outreach-job");
    requests.slice(2).forEach((request, i) => {
      publicRequest(request, "/backlinks", "POST");
      assert.deepEqual(request.body, { domain: priority[i].linking_domain, limit: 1 });
    });
  });
}

test("legacy SDK refuses OAuth access tokens before public REST", async t => {
  const requests = capture(t, () => assert.fail("OAuth token crossed public REST boundary"));
  await sdk(() => TOKEN, async client => {
    const result = await client.callTool({ name: "releases", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Auth failed \(401\)/);
    assert.doesNotMatch(JSON.stringify(result), /cgc_access_/);
  });
  assert.equal(requests.length, 0);
});

const packed = key => Buffer.from(JSON.stringify({ apiKey: key })).toString("base64");
for (const [name, path, headers, expectedKey] of [
  ["bearer", "/mcp", { authorization: `Bearer ${KEY}` }, KEY],
  ["Smithery apiKey", `/mcp?apiKey=${KEY}`, {}, KEY],
  ["Smithery config", `/mcp?config=${encodeURIComponent(packed(KEY))}`, {}, KEY],
  ["header precedence", `/mcp?apiKey=cg_live_query&config=${encodeURIComponent(packed("cg_live_config"))}`, { authorization: `Bearer ${KEY}` }, KEY],
  ["query precedence", `/mcp?apiKey=${KEY}&config=${encodeURIComponent(packed("cg_live_config"))}`, {}, KEY],
]) {
  test(`real legacy /mcp accepts ${name} and returns the old CallToolResult`, async t => {
    const requests = capture(t, () => ({ releases: [release] }));
    await http(t, async request => {
      const response = await request(path, headers);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("www-authenticate"), null);
      const body = await response.json();
      assert.equal(body.id, 1);
      output(body.result, { releases: [release] });
    });
    assert.equal(requests.length, 1);
    publicRequest(requests[0], "/releases", "GET", expectedKey);
  });
}

test("real /mcp isolates consecutive caller keys and rejects OAuth in every legacy credential form", async t => {
  const requests = capture(t, () => ({ releases: [release] }));
  await http(t, async request => {
    for (const key of [KEY, "cg_live_another_caller"]) {
      const response = await request("/mcp", { authorization: `Bearer ${key}` });
      output((await response.json()).result, { releases: [release] });
    }
    for (const [path, headers] of [
      ["/mcp", { authorization: `Bearer ${TOKEN}` }],
      [`/mcp?apiKey=${TOKEN}`, {}],
      [`/mcp?config=${encodeURIComponent(packed(TOKEN))}`, {}],
      [`/mcp?apiKey=${KEY}`, { authorization: `Bearer ${TOKEN}` }],
    ]) {
      const response = await request(path, headers);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.result.isError, true);
      assert.doesNotMatch(JSON.stringify(body), /cgc_access_/);
    }
  });
  assert.equal(requests.length, 2);
  publicRequest(requests[0], "/releases");
  publicRequest(requests[1], "/releases", "GET", "cg_live_another_caller");
});

test("real legacy HTTP keeps missing/malformed-key tool errors and stateless GET/DELETE behavior", async t => {
  const requests = capture(t, () => assert.fail("Missing key must not call public REST"));
  await http(t, async request => {
    for (const path of ["/mcp", "/mcp?config=not-json"]) {
      const response = await request(path);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.result.isError, true);
      assert.match(body.result.content[0].text, /No CrawlGraph API key/);
    }
    for (const method of ["GET", "DELETE"]) {
      const response = await request("/mcp", {}, undefined, method);
      assert.equal(response.status, 405);
      assert.deepEqual(await response.json(), { jsonrpc: "2.0", error: { code: -32000,
        message: "Method not allowed. This server is stateless; use POST." }, id: null });
    }
  });
  assert.equal(requests.length, 0);
});
