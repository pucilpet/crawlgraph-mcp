import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { buildServer, VERSION } from "../dist/server.js";

const API_KEY = "cg_live_fixture";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function withClient(fetchMock, callback) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetchMock;
  const server = buildServer(() => API_KEY);
  const client = new Client({ name: "crawlgraph-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    return await callback(client);
  } finally {
    await client.close();
    await server.close();
    globalThis.fetch = previousFetch;
  }
}

function availableChanges() {
  return {
    domain: "example.com",
    comparison_available: true,
    from_release: { id: "cc-old", label: "Old" },
    to_release: { id: "cc-new", label: "New" },
    counts: {
      from_snapshot: 10,
      to_snapshot: 12,
      added: 2,
      removed: 1,
      authority_moved: 1,
    },
    added: [{ linking_domain: "added.example", num_hosts: 3, cg_authority: 70 }],
    removed: [{ linking_domain: "removed.example", num_hosts: 1, cg_authority: 40 }],
    authority_moved: [{
      linking_domain: "moved.example",
      from_authority: 50,
      to_authority: 60,
      delta: 10,
    }],
    truncated: true,
    cap: 100000,
    snapshot_caveat: "Common Crawl snapshots are periodic observations, not live link monitoring.",
  };
}

function unavailableChanges() {
  return {
    domain: "example.com",
    comparison_available: false,
    from_release: null,
    to_release: { id: "cc-new", label: "New" },
    counts: {
      from_snapshot: 0,
      to_snapshot: 0,
      added: 0,
      removed: 0,
      authority_moved: 0,
    },
    added: [],
    removed: [],
    authority_moved: [],
    truncated: false,
    cap: 100000,
    message: "both indexed release artifacts are required for a comparison",
    snapshot_caveat: "Common Crawl snapshots are periodic observations, not live link monitoring.",
  };
}

test("tools/list exposes five tools and an existing tool still calls through the harness", async () => {
  const requests = [];
  await withClient(async (input, init) => {
    requests.push({ url: String(input), init });
    return jsonResponse({
      domain: "example.com",
      release_id: "cc-new",
      release_label: "New",
      total_linking_domains: 1,
      returned: 1,
      cg_authority: 80,
      cg_rank: 10,
      results: [{
        linking_domain: "referrer.example",
        num_hosts: 1,
        tld: "com",
        cg_authority: 20,
        cg_rank: null,
      }],
    });
  }, async (client) => {
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      ["backlink_changes", "backlinks", "gap_analysis", "gap_outreach_targets", "releases"],
    );
    const result = await client.callTool({
      name: "backlinks",
      arguments: { domain: "example.com", limit: 1 },
    });
    assert.equal(result.isError, undefined);
    assert.equal(requests.length, 1);
  });
});

test("backlink_changes uses the default pair and preserves the available response", async () => {
  const requests = [];
  const data = availableChanges();
  await withClient(async (input, init) => {
    requests.push({ url: String(input), headers: new Headers(init?.headers) });
    return jsonResponse(data);
  }, async (client) => {
    const result = await client.callTool({
      name: "backlink_changes",
      arguments: { domain: "example.com" },
    });
    assert.deepEqual(result.structuredContent, data);
    const request = requests[0];
    assert.equal(request.url, "https://crawlgraph.com/api/v1/changes?domain=example.com");
    assert.equal(request.headers.get("authorization"), `Bearer ${API_KEY}`);
    assert.equal(request.headers.get("user-agent"), `crawlgraph-mcp/${VERSION}`);
    const summary = result.content.find((item) => item.type === "text")?.text || "";
    assert.match(summary, /newest queryable release pair/);
    assert.match(summary, /one backlinks call/);
    assert.match(summary, /not observed/);
    assert.match(summary, /not proven deletion/);
  });
});

test("backlink_changes encodes explicit from and to release ids", async () => {
  const requests = [];
  await withClient(async (input) => {
    requests.push(String(input));
    return jsonResponse(availableChanges());
  }, async (client) => {
    await client.callTool({
      name: "backlink_changes",
      arguments: {
        domain: "example.com",
        from_release: "cc-old/release value",
        to_release: "cc-new?release",
      },
    });
    assert.equal(
      requests[0],
      "https://crawlgraph.com/api/v1/changes?domain=example.com&from=cc-old%2Frelease+value&to=cc-new%3Frelease",
    );
  });
});

test("backlink_changes returns a successful unavailable comparison", async () => {
  const data = unavailableChanges();
  await withClient(async () => jsonResponse(data), async (client) => {
    const result = await client.callTool({
      name: "backlink_changes",
      arguments: { domain: "example.com" },
    });
    assert.notEqual(result.isError, true);
    assert.deepEqual(result.structuredContent, data);
    const summary = result.content.find((item) => item.type === "text")?.text || "";
    assert.match(summary, /comparison_available: false/);
    assert.match(summary, /two queryable snapshots do not exist/);
  });
});

for (const status of [401, 403, 429]) {
  test(`backlink_changes redacts the API key for HTTP ${status}`, async () => {
    await withClient(
      async () => jsonResponse({ error: "upstream", message: `reflected ${API_KEY}` }, status),
      async (client) => {
        const result = await client.callTool({
          name: "backlink_changes",
          arguments: { domain: "example.com" },
        });
        assert.equal(result.isError, true);
        const text = result.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n");
        assert.doesNotMatch(text, new RegExp(API_KEY));
        assert.match(text, new RegExp(String(status)));
      },
    );
  });
}
