import assert from "node:assert/strict";
import http from "node:http";
import { Duplex } from "node:stream";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { OAuthClientMetadataSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import { createApp, logStartupFailure } from "../dist/http.js";
import express from "express";
import { protectedConnectorHandler, sendConnectorError } from "../dist/oauth/router.js";
import { BackendClient, verifiedIngress, logConnectorTelemetry } from "../dist/backend-client.js";
import { buildServer, VERSION } from "../dist/server.js";

const PACKAGE_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

// Local protocol evidence only: fake callbacks and credentials establish no
// compatibility claim for Claude/OpenAI or a deployed proxy/backend.
const ISSUER = "https://crawlgraph.com";
const RESOURCE = `${ISSUER}/mcp/connectors`;
const SCOPE = "crawlgraph:read";
const CALLBACK = "https://fixture-client.example.test/oauth/callback";
const OTHER_CALLBACK = "https://second-client.example.test/oauth/callback";
// Synthetic credentials are constructed from repeated fixture characters.
const SECRET = `fixture-service-secret-${"0".repeat(20)}`;
const SOURCE = "203.0.113.19";
const ACCESS = `cgc_access_${"a".repeat(43)}`;
const OTHER_ACCESS = `cgc_access_${"b".repeat(43)}`;
const REFRESH = `cgc_refresh_${"r".repeat(43)}`;
const VERIFIER = "v".repeat(43);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const CHALLENGE_HEADER = `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp/connectors", scope="${SCOPE}"`;
const TOKENS = { access_token: ACCESS, refresh_token: REFRESH, expires_in: 600, scope: SCOPE, token_type: "Bearer" };

const HTTP_CATEGORIES = new Set(["connector", "oauth_authorize", "oauth_token", "oauth_register", "oauth_revoke",
  "oauth_other", "authorization_metadata", "resource_metadata", "unknown"]);
const HTTP_CODES = new Set(["invalid_request", "invalid_client", "invalid_client_metadata", "invalid_grant", "invalid_scope",
  "invalid_target", "invalid_token", "insufficient_scope", "unauthorized_client", "access_denied",
  "unsupported_grant_type", "unsupported_response_type", "unsupported_token_type", "server_error",
  "temporarily_unavailable", "too_many_requests", "method_not_allowed", "missing_bearer", "untrusted_peer", "disabled"]);
function httpTelemetry(logs, expected) {
  assert.equal(logs.length, expected.length, "exactly one error line per response");
  const records = logs.map(line => {
    const record = JSON.parse(line);
    assert.deepEqual(Object.keys(record).sort(), ["event", "request_id", "category", "status", "code"].sort());
    assert.equal(record.event, "connector_http");
    assert.match(record.request_id, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
    assert.ok(HTTP_CATEGORIES.has(record.category));
    assert.ok(HTTP_CODES.has(record.code));
    assert.ok(Number.isInteger(record.status) && record.status >= 100 && record.status <= 599);
    return record;
  });
  assert.equal(new Set(records.map(record => record.request_id)).size, records.length);
  for (const [i, values] of expected.entries()) {
    assert.deepEqual({ category: records[i].category, status: records[i].status, code: records[i].code }, values);
  }
  noCredentials({ text: logs.join("\n") });
  return records;
}

// Real Express/SDK parsers and handlers with an in-memory HTTP stream. No
// listener or network capability is needed; the existing socket fixtures stay.
async function inProcessRequest(app, path, { method = "GET", body, headers = {}, peer = "127.0.0.1" } = {}) {
  const chunks = [];
  const socket = new Duplex({ read() {}, write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
  socket.remoteAddress = peer;
  const req = new http.IncomingMessage(socket);
  req.method = method;
  req.url = path;
  req.httpVersion = "1.1";
  req.headers = { host: "crawlgraph.com", "x-forwarded-for": SOURCE, ...headers,
    ...(body !== undefined ? { "content-length": String(Buffer.byteLength(body)) } : {}) };
  req.rawHeaders = Object.entries(req.headers).flat();
  const res = new http.ServerResponse(req);
  res.assignSocket(socket);
  const finished = new Promise((resolve, reject) => { res.once("finish", resolve); res.once("error", reject); });
  app(req, res);
  if (body !== undefined) req.push(Buffer.from(body));
  req.push(null);
  req.complete = true;
  await finished;
  await new Promise(resolve => setImmediate(resolve));
  const wire = Buffer.concat(chunks).toString("utf8");
  const text = wire.slice(wire.indexOf("\r\n\r\n") + 4);
  socket.destroy();
  return { status: res.statusCode, headers: new Headers(res.getHeaders()), text,
    body: res.getHeader("content-type")?.includes("application/json") ? JSON.parse(text) : text };
}

async function inProcessFixture() {
  const clients = new Map(), calls = [];
  const state = { failure: null, failurePath: null };
  const app = await createApp({ env: { CONNECTOR_ENABLED: "true", CONNECTOR_SERVICE_SECRET: SECRET,
    CONNECTOR_REDIRECT_URIS: CALLBACK, CONNECTOR_NGINX_PEER_IPS: "127.0.0.1" },
    resolveNginxPeers: async () => ["127.0.0.1"], backendFetch: async (url, init) => {
      const path = new URL(url).pathname;
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ path, body });
      if (state.failure && (!state.failurePath || path.endsWith(state.failurePath))) throw new Error(state.failure);
      let data;
      if (path.endsWith("/clients/register")) {
        const client = { ...body.metadata, client_id: "private-client-id", client_id_issued_at: 1 };
        clients.set(client.client_id, client); data = { client };
      } else if (path.includes("/clients/")) data = { client: clients.get(path.split("/").at(-1)) ?? null };
      else if (path.endsWith("/tokens/code")) return Response.json({ error: "invalid_grant" }, { status: 400 });
      else if (path.endsWith("/tokens/revoke")) data = { status: "ok" };
      else if (path.endsWith("/tokens/introspect")) data = {
        user_id: 17, tier: "lifetime", auth_kind: "account", grant_id: "private-grant-id", client_id: "private-client-id",
        family_id: "private-family-id", resource: RESOURCE, scopes: [SCOPE], expires_at: 4102444800, grant_expires_at: 4102444800,
      };
      else if (path.endsWith("/operations/execute")) data = { operation: "releases", status: "complete", error: null,
        quota: [], quota_consumed: { category: null, count: 0 }, data: { releases: [] } };
      else assert.fail("Unexpected fixture RPC");
      return Response.json(data);
    } });
  const request = (path, options) => inProcessRequest(app, path, options);
  const post = (path, data, json = false, headers = {}) => request(path, { method: "POST",
    body: json ? JSON.stringify(data) : new URLSearchParams(data).toString(),
    headers: { "content-type": json ? "application/json" : "application/x-www-form-urlencoded", ...headers } });
  return { app, request, post, calls, state };
}

async function listen(t, server) {
  server.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t, { enabled = true, peer = "127.0.0.1" } = {}) {
  const clients = new Map();
  const calls = [];
  const destinations = [];
  const state = { lookupFailure: null, executionFailure: null, introspectionFailure: null, introspectionOverrides: {} };
  const owners = new Map([[ACCESS, { user_id: 11, grant_id: "grant_a", client_id: "client_a", family_id: "family_a" }],
    [OTHER_ACCESS, { user_id: 22, grant_id: "grant_b", client_id: "client_b", family_id: "family_b" }]]);
  const backend = http.createServer(async (req, res) => {
    try {
      let text = "";
      for await (const chunk of req) text += chunk;
      const body = text ? JSON.parse(text) : undefined;
      const record = { path: req.url, method: req.method, headers: req.headers, body };
      calls.push(record);
      assert.equal(req.headers["x-crawlgraph-service-token"], SECRET);
      const reply = (status, data, retry) => {
        res.writeHead(status, { "content-type": "application/json", ...(retry ? { "retry-after": String(retry) } : {}) });
        res.end(JSON.stringify(data));
      };
      const failure = error => reply(error.status, { error: error.code }, error.retry);
      if (req.url.startsWith("/internal/mcp/clients/") && req.url !== "/internal/mcp/clients/register") {
        if (state.lookupFailure) return failure(state.lookupFailure);
        return reply(200, { client: clients.get(req.url.split("/").at(-1)) ?? null });
      }
      assert.equal(body.source_verified, true);
      assert.ok(body.source === SOURCE || body.source === "198.51.100.22");
      if (req.url === "/internal/mcp/clients/register") {
        const client = { ...body.metadata, client_id: `client_${clients.size + 1}`, client_id_issued_at: 1 };
        clients.set(client.client_id, client);
        return reply(200, { client });
      }
      if (req.url === "/internal/mcp/authorizations/begin") {
        const id = "t".repeat(43);
        return reply(200, { transaction_id: id, frontend_path: `/connectors/authorize?transaction_id=${id}`, expires_in: 2700 });
      }
      if (req.url === "/internal/mcp/tokens/code") {
        if (body.redirect_uri !== undefined && body.redirect_uri !== CALLBACK) return reply(400, { error: "invalid_grant" });
        if (body.verifier !== VERIFIER) return reply(400, { error: "invalid_grant" });
        return reply(200, TOKENS);
      }
      if (req.url === "/internal/mcp/tokens/refresh") return reply(200, TOKENS);
      if (req.url === "/internal/mcp/tokens/revoke") return reply(200, { status: "ok" });
      if (req.url === "/internal/mcp/tokens/introspect") {
        if (state.introspectionFailure) return failure(state.introspectionFailure);
        const owner = owners.get(body.token);
        if (!owner) return reply(401, { error: "invalid_token" });
        return reply(200, { ...owner, tier: "free", auth_kind: "account", resource: RESOURCE, scopes: [SCOPE],
          expires_at: Math.floor(Date.now() / 1000) + 600, grant_expires_at: Math.floor(Date.now() / 1000) + 3600,
          ...state.introspectionOverrides });
      }
      if (req.url === "/internal/mcp/operations/execute") {
        if (state.executionFailure) return failure(state.executionFailure);
        const owner = owners.get(req.headers.authorization?.slice(7));
        if (!owner) return reply(401, { error: "invalid_token" });
        // Vary delay by principal to interleave real concurrent HTTP requests.
        await new Promise(resolve => setTimeout(resolve, owner.user_id === 11 ? 12 : 1));
        return reply(200, { operation: "releases", status: "complete", error: null, quota: [],
          quota_consumed: { category: null, count: 0 }, data: { releases: [
            { id: `owner-${owner.user_id}`, label: `Result for ${owner.grant_id}`, available: true },
          ] } });
      }
      throw new Error("Unexpected private RPC");
    } catch (error) {
      // Fixture assertion failures are recorded without logging raw requests.
      state.fixtureError = error;
      res.writeHead(500, { "content-type": "application/json" });
      res.end('{"error":"temporarily_unavailable"}');
    }
  });
  const backendBase = await listen(t, backend);
  const app = await createApp({ env: { CONNECTOR_ENABLED: String(enabled), CONNECTOR_SERVICE_SECRET: SECRET,
    CONNECTOR_REDIRECT_URIS: `${CALLBACK},${OTHER_CALLBACK}`, CONNECTOR_NGINX_PEER_IPS: peer },
    resolveNginxPeers: async hostname => { assert.equal(hostname, "nginx"); return [peer]; },
    backendFetch: async (url, init) => {
      destinations.push({ url: String(url), init });
      assert.match(String(url), /^http:\/\/backend:8000\/internal\/mcp\//);
      assert.equal(init.redirect, "error");
      return fetch(`${backendBase}${new URL(url).pathname}`, init);
    } });
  const base = await listen(t, http.createServer(app));
  t.after(() => { if (state.fixtureError) throw state.fixtureError; });
  const request = async (path, body, { json = false, headers = {}, method } = {}) => {
    const response = await fetch(`${base}${path}`, { redirect: "manual", method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { "x-forwarded-for": SOURCE, ...(body === undefined ? {} : { "content-type": json ? "application/json" : "application/x-www-form-urlencoded" }), ...headers },
      ...(body === undefined ? {} : { body: json ? JSON.stringify(body) : new URLSearchParams(body).toString() }) });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: response.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) : text, text };
  };
  const raw = (path, headers, body, { localAddress } = {}) => new Promise((resolve, reject) => {
    const rawHeaders = [...headers];
    const hasHeader = name => rawHeaders.some((value, index) => index % 2 === 0 && value.toLowerCase() === name);
    // Node does not supply Host when headers are passed as a raw array.
    if (!hasHeader("host")) rawHeaders.push("Host", new URL(base).host);
    if (!hasHeader("connection")) rawHeaders.push("Connection", "close");
    if (body !== undefined && !hasHeader("content-length") && !hasHeader("transfer-encoding")) {
      rawHeaders.push("Content-Length", String(Buffer.byteLength(body)));
    }
    const req = http.request(`${base}${path}`, { headers: rawHeaders, method: body === undefined ? "GET" : "POST", localAddress }, res => {
      const chunks = [];
      let bytes = 0;
      res.on("error", reject);
      res.on("aborted", () => reject(new Error("Fixture response aborted")));
      res.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > 64 * 1024) {
          const error = new Error("Fixture response exceeded 64 KiB");
          reject(error);
          res.destroy(error);
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        try {
          const text = Buffer.concat(chunks).toString("utf8");
          const responseHeaders = new Headers(res.headers);
          const type = responseHeaders.get("content-type")?.split(";")[0].trim().toLowerCase();
          resolve({ status: res.statusCode, headers: responseHeaders,
            body: text && type === "application/json" ? JSON.parse(text) : text, text });
        } catch (error) { reject(error); }
      });
    });
    req.on("error", reject); req.end(body);
  });
  const register = metadata => request("/oauth/register", { redirect_uris: [CALLBACK], ...metadata }, { json: true });
  const client = async () => { const r = await register({ token_endpoint_auth_method: "none" }); assert.equal(r.status, 201); return r.body.client_id; };
  const authorization = (id, overrides = {}) => ({ client_id: id, redirect_uri: CALLBACK, response_type: "code",
    code_challenge: CHALLENGE, code_challenge_method: "S256", resource: RESOURCE, state: "state + / &", ...overrides });
  const auth = (id, overrides) => request(`/oauth/authorize?${new URLSearchParams(authorization(id, overrides))}`);
  const exchange = (id, overrides = {}) => request("/oauth/token", { client_id: id, grant_type: "authorization_code",
    code: "fixture-code", code_verifier: VERIFIER, resource: RESOURCE, ...overrides });
  const tool = (token = ACCESS, source = SOURCE, id = 1) => request("/mcp/connectors", { jsonrpc: "2.0", id,
    method: "tools/call", params: { name: "releases", arguments: {} } }, { json: true,
    headers: { authorization: `Bearer ${token}`, "x-forwarded-for": source, accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-03-26" } });
  return { request, raw, register, client, authorization, auth, exchange, tool, calls, destinations, state };
}

function error(r, status, code) {
  assert.equal(r.status, status);
  assert.equal(r.body.error, code);
  assert.equal(r.headers.get("location"), null);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(r.headers.get("referrer-policy"), "no-referrer");
}
function redirectError(r, code, state = "state + / &") {
  assert.equal(r.status, 302);
  const url = new URL(r.headers.get("location"));
  assert.equal(`${url.origin}${url.pathname}`, CALLBACK);
  assert.equal(url.searchParams.get("error"), code);
  assert.equal(url.searchParams.get("state"), state);
  assert.deepEqual([...url.searchParams.keys()].sort(), ["error", "error_description", "state"].sort());
}
function noCredentials(r) {
  for (const value of [SECRET, ACCESS, OTHER_ACCESS, REFRESH, VERIFIER, "fixture-code"]) assert.equal(r.text.includes(value), false);
}

function throttle(r, retryAfter) {
  error(r, 429, "too_many_requests");
  assert.deepEqual(r.body, { error: "too_many_requests", error_description: "Connector rate limit exceeded" });
  assert.equal(r.headers.get("retry-after"), String(retryAfter));
  assert.equal(r.headers.get("www-authenticate"), null);
  assert.equal(r.headers.get("set-cookie"), null);
  noCredentials(r);
}

function unknownClient(f, endpoint, index, headers = {}) {
  return f.request(`/oauth/${endpoint}`, { client_id: `unknown_${index}`, grant_type: "refresh_token",
    refresh_token: REFRESH, token: ACCESS }, { headers });
}

test("socket-free runtime version, SDK initialize and API User-Agent match independently read package JSON", async t => {
  assert.equal(PACKAGE_VERSION, "0.4.0");
  assert.equal(VERSION, PACKAGE_VERSION);
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    requests.push(new Headers(init.headers));
    return new Response('{"releases":[]}', { headers: { "content-type": "application/json" } });
  });
  const server = buildServer(() => "cg_live_version_fixture");
  const client = new Client({ name: "version-fixture", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    assert.equal(client.getServerVersion().version, PACKAGE_VERSION);
    const result = await client.callTool({ name: "releases", arguments: {} });
    assert.equal(result.isError, undefined);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].get("user-agent"), `crawlgraph-mcp/${PACKAGE_VERSION}`);
  } finally {
    await client.close();
    await server.close();
  }
});

test("real healthz and both HTTP SDK initialize profiles match package version", async t => {
  const f = await fixture(t);
  const health = await f.request("/healthz");
  assert.equal(health.status, 200);
  assert.equal(health.body.version, PACKAGE_VERSION);
  const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "version-fixture", version: "1" },
  } };
  for (const path of ["/mcp", "/mcp/connectors"]) {
    const r = await f.request(path, initialize, { json: true, headers: {
      accept: "application/json, text/event-stream", authorization: `Bearer ${ACCESS}`,
    } });
    assert.equal(r.status, 200);
    assert.equal(r.body.result.serverInfo.version, PACKAGE_VERSION);
  }
});

for (const endpoint of ["token", "revoke"]) {
  test(`unknown-client ${endpoint} admission stops private lookups and shares its window with the other endpoint`, async t => {
    let now = 1000;
    t.mock.method(performance, "now", () => now);
    const f = await fixture(t);
    // Interleave HTTP requests at the boundary: synchronous admission admits exactly 1,000.
    for (let start = 0; start < 990; start += 30) {
      const results = await Promise.all(Array.from({ length: 30 }, (_, i) => unknownClient(f, endpoint, start + i)));
      for (const r of results) error(r, 400, "invalid_client");
    }
    const boundary = await Promise.all(Array.from({ length: 20 }, (_, i) => unknownClient(f, endpoint, 990 + i)));
    assert.equal(boundary.filter(r => r.status === 400).length, 10);
    assert.equal(boundary.filter(r => r.status === 429).length, 10);
    for (const r of boundary) r.status === 429 ? throttle(r, 60) : error(r, 400, "invalid_client");
    assert.equal(f.calls.length, 1000);
    assert.ok(f.calls.every(c => c.method === "GET" && /^\/internal\/mcp\/clients\/unknown_/.test(c.path)));
    const other = endpoint === "token" ? "revoke" : "token";
    throttle(await unknownClient(f, other, "other"), 60);
    // Equivalent verified IP spelling and caller-controlled labels cannot reset admission.
    throttle(await unknownClient(f, endpoint, "alias", {
      "x-forwarded-for": `::ffff:${SOURCE}`, "x-real-ip": "198.51.100.22", forwarded: "for=198.51.100.22",
      authorization: `Bearer ${OTHER_ACCESS}`,
    }), 60);
    assert.equal(f.calls.length, 1000);
    error(await unknownClient(f, other, "second", { "x-forwarded-for": "198.51.100.22" }), 400, "invalid_client");
    assert.equal(f.calls.length, 1001);
    now += 58_499;
    throttle(await unknownClient(f, other, "rounding"), 2);
    now += 1500;
    throttle(await unknownClient(f, endpoint, "last_ms"), 1);
    assert.equal(f.calls.length, 1001);
    now += 1;
    error(await unknownClient(f, other, "expired"), 400, "invalid_client");
    assert.equal(f.calls.length, 1002);
  });
}

test("authorize admission precedes client lookup, keeps GET/POST together and isolates other policies and sources", async t => {
  let now = 1000;
  t.mock.method(performance, "now", () => now);
  const f = await fixture(t);
  const id = await f.client();
  for (let i = 0; i < 100; i++) error(await f.auth(`unknown_${i}`), 400, "invalid_client");
  const lookupCount = () => f.calls.filter(c => c.method === "GET").length;
  assert.equal(lookupCount(), 100);
  throttle(await f.auth(id), 900);
  throttle(await f.request("/oauth/authorize?state=query", f.authorization(id, { state: ACCESS })), 900);
  assert.equal(lookupCount(), 100);
  assert.equal(f.calls.filter(c => c.path.endsWith("/begin")).length, 0);
  assert.equal((await f.exchange(id)).status, 200);
  assert.equal((await f.register({ token_endpoint_auth_method: "none" })).status, 201);
  const second = await f.request(`/oauth/authorize?${new URLSearchParams(f.authorization(id))}`, undefined,
    { headers: { "x-forwarded-for": "198.51.100.22" } });
  assert.equal(second.status, 302);
  assert.equal(f.calls.at(-1).body.source, "198.51.100.22");
  const admittedCalls = f.calls.length;
  now += 898_499;
  throttle(await f.auth(id), 2);
  now += 1500;
  throttle(await f.auth(id), 1);
  assert.equal(f.calls.length, admittedCalls);
  now += 1;
  error(await f.auth("unknown_expired"), 400, "invalid_client");
  assert.equal(f.calls.length, admittedCalls + 1);
});

test("DCR admission enforces 200/hour separately before RPC and preserves parser privacy on rejection", async t => {
  let now = 1000;
  t.mock.method(performance, "now", () => now);
  const f = await fixture(t);
  for (let i = 0; i < 200; i++) assert.equal((await f.register({ token_endpoint_auth_method: "none" })).status, 201);
  assert.equal(f.calls.length, 200);
  throttle(await f.register({ client_secret: SECRET }), 3600);
  const malformed = `{"token":"${ACCESS}","secret":"${SECRET}",`;
  throttle(await f.raw("/oauth/register", ["X-Forwarded-For", SOURCE, "Content-Type", "application/json"], malformed), 3600);
  assert.equal(f.calls.length, 200);
  // A saturated registration bucket does not consume authorization or token admission.
  error(await f.auth("unknown_dcr"), 400, "invalid_client");
  error(await unknownClient(f, "token", "dcr"), 400, "invalid_client");
  assert.equal((await f.request("/oauth/register", { redirect_uris: [CALLBACK] }, {
    json: true, headers: { "x-forwarded-for": "198.51.100.22" },
  })).status, 201);
  const admittedCalls = f.calls.length;
  now += 3_598_499;
  throttle(await f.register({}), 2);
  now += 1500;
  throttle(await f.register({}), 1);
  assert.equal(f.calls.length, admittedCalls);
  now += 1;
  assert.equal((await f.register({})).status, 201);
});

test("malformed and oversized OAuth traffic consumes source admission before parsing without credential logs", async t => {
  t.mock.method(performance, "now", () => 1000);
  const logs = [];
  t.mock.method(console, "error", (...values) => logs.push(values.map(String).join(" ")));
  const f = await fixture(t);
  const headers = ["X-Forwarded-For", SOURCE, "Content-Type", "application/json"];
  const malformed = `{"token":"${ACCESS}","secret":"${SECRET}",`;
  for (let i = 0; i < 199; i++) {
    const r = await f.raw("/oauth/register", headers, malformed);
    error(r, 400, "invalid_request"); noCredentials(r);
    assert.equal(r.headers.get("www-authenticate"), null);
  }
  const oversized = JSON.stringify({ token: ACCESS, secret: SECRET, padding: "x".repeat(16 * 1024) });
  const r = await f.raw("/oauth/register", headers, oversized);
  error(r, 413, "invalid_request"); noCredentials(r);
  throttle(await f.raw("/oauth/register", headers, oversized), 3600);
  assert.equal(f.calls.length, 0);
  httpTelemetry(logs, [
    ...Array.from({ length: 199 }, () => ({ category: "oauth_register", status: 400, code: "invalid_request" })),
    { category: "oauth_register", status: 413, code: "invalid_request" },
    { category: "oauth_register", status: 429, code: "too_many_requests" },
  ]);
});

test("source capacity fails closed without evicting live windows and prunes only expired buckets", async t => {
  let now = 1000;
  t.mock.method(performance, "now", () => now);
  const f = await fixture(t);
  for (let i = 0; i < 100; i++) error(await f.auth(`unknown_${i}`), 400, "invalid_client");
  now += 2000;
  // Synthetic documentation-only IPv6 sources; missing client_id never reaches private storage.
  for (let start = 1; start < 4096; start += 64) {
    const results = await Promise.all(Array.from({ length: Math.min(64, 4096 - start) }, (_, i) =>
      f.request("/oauth/authorize", undefined, { headers: { "x-forwarded-for": `2001:db8:${(start + i).toString(16)}::1` } })));
    for (const r of results) error(r, 400, "invalid_request");
  }
  const secondSource = { headers: { "x-forwarded-for": "198.51.100.22" } };
  const authPath = `/oauth/authorize?${new URLSearchParams(f.authorization("unknown_capacity"))}`;
  for (let i = 0; i < 3; i++) throttle(await f.request(authPath, undefined, secondSource), 898);
  throttle(await f.auth("unknown_still_limited"), 898);
  assert.equal(f.calls.length, 100);
  // Existing unsaturated sources still work; capacity is independent of the DCR policy.
  error(await f.request(authPath, undefined, { headers: { "x-forwarded-for": "2001:db8:fff::2" } }), 400, "invalid_client");
  assert.equal((await f.register({})).status, 201);
  now = 900_999;
  throttle(await f.request(authPath, undefined, secondSource), 1);
  now = 901_000;
  error(await f.request(authPath, undefined, secondSource), 400, "invalid_client");
  // Reclaimed capacity is occupied again; a removed source cannot displace a live bucket.
  throttle(await f.auth("unknown_capacity_again"), 2);
  now = 903_000;
  error(await f.auth("unknown_pruned"), 400, "invalid_client");
  assert.equal(f.calls.filter(c => c.method === "GET").length, 103);
});

test("untrusted peer and missing/duplicate/spoofed XFF cannot bypass or reset a saturated source", async t => {
  t.mock.method(performance, "now", () => 1000);
  const f = await fixture(t);
  for (let i = 0; i < 100; i++) error(await f.auth(`unknown_${i}`), 400, "invalid_client");
  const malformed = `{"token":"${ACCESS}",`;
  for (const headers of [[], ["X-Forwarded-For", SOURCE, "X-Forwarded-For", "198.51.100.22"],
    ["X-Forwarded-For", `${SOURCE}, 198.51.100.22`], ["X-Forwarded-For", "invalid"],
    ["X-Real-IP", "198.51.100.22", "Forwarded", "for=198.51.100.22"]]) {
    for (const endpoint of ["authorize", "register", "token", "revoke"]) {
      const r = await f.raw(`/oauth/${endpoint}`, [...headers, "Content-Type", "application/json"], malformed);
      error(r, 503, "temporarily_unavailable");
      assert.equal(r.headers.get("www-authenticate"), null); noCredentials(r);
    }
  }
  for (const source of [SOURCE, "198.51.100.22"]) {
    const r = await f.raw("/oauth/authorize", ["X-Forwarded-For", source, "Content-Type", "application/json"],
      malformed, { localAddress: "127.0.0.2" });
    error(r, 503, "temporarily_unavailable");
    assert.equal(r.headers.get("www-authenticate"), null); noCredentials(r);
  }
  throttle(await f.auth("unknown_after_spoof"), 900);
  assert.equal(f.calls.length, 100);
});

test("createApp serves exact public-only metadata and the canonical resource challenge", async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.request("/.well-known/oauth-authorization-server")).body, {
    issuer: ISSUER, authorization_endpoint: `${ISSUER}/oauth/authorize`, token_endpoint: `${ISSUER}/oauth/token`,
    registration_endpoint: `${ISSUER}/oauth/register`, revocation_endpoint: `${ISSUER}/oauth/revoke`,
    revocation_endpoint_auth_methods_supported: ["none"], response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"], scopes_supported: [SCOPE], client_id_metadata_document_supported: false,
  });
  assert.deepEqual((await f.request("/.well-known/oauth-protected-resource/mcp/connectors")).body,
    { resource: RESOURCE, authorization_servers: [ISSUER], scopes_supported: [SCOPE] });
  const r = await f.request("/mcp/connectors");
  error(r, 401, "invalid_token");
  assert.equal(r.headers.get("www-authenticate"), CHALLENGE_HEADER);
  assert.equal(f.calls.length, 0);
});

test("disabled surfaces and introspection outages return503 without relink challenges", async t => {
  const disabled = await fixture(t, { enabled: false });
  for (const path of ["/mcp/connectors", "/oauth/token", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp/connectors"]) {
    const r = await disabled.request(path); error(r, 503, "temporarily_unavailable");
    assert.equal(r.headers.get("retry-after"), "5"); assert.equal(r.headers.get("www-authenticate"), null);
  }
  const f = await fixture(t);
  f.state.introspectionFailure = { status: 503, code: "temporarily_unavailable" };
  const r = await f.tool(); error(r, 503, "temporarily_unavailable");
  assert.equal(r.headers.get("retry-after"), "5"); assert.equal(r.headers.get("www-authenticate"), null);
});

test("real SDK DCR normalizes omission, discards generated secrets and rejects confidential clients", async t => {
  const f = await fixture(t);
  for (const metadata of [{ token_endpoint_auth_method: "none" }, {}]) {
    const r = await f.register(metadata); assert.equal(r.status, 201);
    assert.equal(r.body.token_endpoint_auth_method, "none");
    for (const key of ["client_secret", "client_secret_expires_at"]) {
      assert.equal(Object.hasOwn(r.body, key), false);
      assert.equal(Object.hasOwn(f.calls.at(-1).body.metadata, key), false);
    }
    assert.equal(Object.hasOwn(f.calls.at(-1).body.metadata, "client_id"), false);
  }
  for (const method of ["client_secret_post", "client_secret_basic", "private_key_jwt"]) error(await f.register({ token_endpoint_auth_method: method }), 400, "invalid_client_metadata");
  const aliases = ["https://fixture-client.example.test:443/oauth/callback",
    "https://fixture-client.example.test/oauth/../oauth/callback", "https://fixture-client.example.test/oauth/./callback",
    "https://fixture-client.example.test/oauth/%2e%2e/oauth/callback", "https://FIXTURE-CLIENT.example.test/oauth/callback",
    "HTTPS://fixture-client.example.test/oauth/callback", ` ${CALLBACK} `, "https://fixture-client.example.test/oauth\\callback"];
  for (const callback of aliases) {
    assert.deepEqual(OAuthClientMetadataSchema.parse({ redirect_uris: [callback] }).redirect_uris, [CALLBACK]);
  }
  for (const callback of [`${CALLBACK}?extra=1`, `${CALLBACK}#fragment`, `${CALLBACK}/`, "https://evil.example.test/oauth/callback", ...aliases]) {
    for (const redirect_uris of [[callback], [CALLBACK, callback]]) {
      const r = await f.register({ redirect_uris, token_endpoint_auth_method: "none" });
      error(r, 400, "invalid_client_metadata"); noCredentials(r);
      assert.equal(f.calls.filter(c => c.path.endsWith("/register")).length, 2);
    }
  }
  for (const redirect_uris of [undefined, null, CALLBACK, { 0: CALLBACK }, [], [null], [1], [true], [{}],
    [CALLBACK, null], [CALLBACK, CALLBACK], [CALLBACK, OTHER_CALLBACK, CALLBACK], Array(6).fill(CALLBACK)]) {
    const r = await f.register({ redirect_uris, token_endpoint_auth_method: "none" });
    error(r, 400, "invalid_client_metadata"); noCredentials(r);
    assert.equal(f.calls.filter(c => c.path.endsWith("/register")).length, 2);
  }
  assert.equal(f.calls.filter(c => c.path.endsWith("/register")).length, 2);
  const redirect_uris = [OTHER_CALLBACK, CALLBACK];
  const multiple = await f.register({ redirect_uris });
  assert.equal(multiple.status, 201);
  assert.deepEqual(multiple.body.redirect_uris, redirect_uris);
  assert.deepEqual(f.calls.at(-1).body.metadata.redirect_uris, redirect_uris);
  assert.equal(multiple.body.token_endpoint_auth_method, "none");
  assert.equal(f.calls.filter(c => c.path.endsWith("/register")).length, 3);
  noCredentials(multiple);
});

test("successful introspection still requires exact resource, live access/grant expiry and only the approved scope", async t => {
  const f = await fixture(t);
  for (const [overrides, status, code] of [
    [{ resource: "https://crawlgraph.com/api/v1" }, 401, "invalid_token"],
    [{ resource: "https://crawlgraph.com:443/mcp/connectors" }, 401, "invalid_token"],
    [{ expires_at: 1 }, 401, "invalid_token"],
    [{ grant_expires_at: 1 }, 401, "invalid_token"],
    [{ scopes: [] }, 403, "insufficient_scope"],
    [{ scopes: [SCOPE, "admin"] }, 403, "insufficient_scope"],
    [{ scopes: ["admin"] }, 403, "insufficient_scope"],
  ]) {
    f.state.introspectionOverrides = overrides;
    const result = await f.tool();
    error(result, status, code);
    assert.equal(result.headers.get("www-authenticate"), `${CHALLENGE_HEADER}, error="${code}"`);
    assert.equal(result.headers.get("retry-after"), null);
    noCredentials(result);
  }
  assert.equal(f.calls.filter(call => call.path.endsWith("/introspect")).length, 7);
  assert.equal(f.calls.filter(call => call.path.endsWith("/execute")).length, 0);
});

test("registered callback errors preserve only protocol fields and POST body state wins query conflicts", async t => {
  const f = await fixture(t); const id = await f.client();
  for (const state of ["body-state + &", ""]) {
    const r = await f.request(`/oauth/authorize?${new URLSearchParams({ client_id: "unknown", state: "query-state", redirect_uri: OTHER_CALLBACK })}`,
      f.authorization(id, { state, code_challenge_method: "plain" }));
    redirectError(r, "invalid_request", state); noCredentials(r);
  }
  redirectError(await f.auth(id, { scope: "admin" }), "invalid_scope");
  for (const redirect_uri of [OTHER_CALLBACK, `${CALLBACK}/`, "https://fixture-client.example.test:443/oauth/callback", "https://fixture-client.example.test/oauth/../oauth/callback", "https://evil.example.test/callback"]) {
    error(await f.auth(id, { redirect_uri }), 400, "invalid_request");
  }
  error(await f.auth("unknown", { code_challenge_method: "plain" }), 400, "invalid_client");
  assert.equal(f.calls.filter(c => c.path.endsWith("/begin")).length, 0);
});

test("authorization requires raw exact resource and forwards server-owned S256/default scope/browser binding", async t => {
  const f = await fixture(t); const id = await f.client();
  const r = await f.auth(id); assert.equal(r.status, 302);
  assert.match(r.headers.get("set-cookie"), /cg_connector_nonce=[A-Za-z0-9_-]{43};.*HttpOnly.*Secure.*SameSite=Lax/);
  assert.equal(r.headers.get("location"), `${ISSUER}/connectors/authorize?transaction_id=${"t".repeat(43)}`);
  const begin = f.calls.at(-1).body;
  assert.equal(begin.resource, RESOURCE); assert.equal(begin.redirect_uri, CALLBACK);
  assert.deepEqual(begin.scopes, [SCOPE]); assert.equal(begin.code_challenge_method, "S256");
  assert.equal(begin.code_challenge, CHALLENGE); assert.match(begin.browser_nonce, /^[A-Za-z0-9_-]{43}$/);
  for (const resource of ["https://crawlgraph.com:443/mcp/connectors", "https://crawlgraph.com/mcp/../mcp/connectors", `${RESOURCE}/`, "https://CRAWLGRAPH.com/mcp/connectors"]) {
    redirectError(await f.auth(id, { resource }), "invalid_target");
  }
  const omitted = f.authorization(id); delete omitted.resource;
  redirectError(await f.request(`/oauth/authorize?${new URLSearchParams(omitted)}`), "invalid_target");
  assert.equal(f.calls.filter(c => c.path.endsWith("/begin")).length, 1);
});

test("code exchanges keep raw resource exact and forward omitted/provided redirect and verifier to atomic backend", async t => {
  const f = await fixture(t); const id = await f.client();
  assert.equal((await f.exchange(id)).status, 200);
  const first = f.calls.at(-1).body;
  assert.equal(Object.hasOwn(first, "redirect_uri"), false); assert.equal(first.verifier, VERIFIER); assert.equal(first.resource, RESOURCE);
  assert.equal((await f.exchange(id, { redirect_uri: CALLBACK })).status, 200);
  assert.equal(f.calls.at(-1).body.redirect_uri, CALLBACK);
  error(await f.exchange(id, { redirect_uri: "https://fixture-client.example.test:443/oauth/callback" }), 400, "invalid_grant");
  assert.equal(f.calls.at(-1).body.redirect_uri, "https://fixture-client.example.test:443/oauth/callback");
  error(await f.exchange(id, { code_verifier: "w".repeat(43) }), 400, "invalid_grant");
  assert.equal(f.calls.at(-1).body.verifier, "w".repeat(43));
  const count = f.calls.filter(c => c.path.endsWith("/code")).length;
  for (const resource of ["https://crawlgraph.com:443/mcp/connectors", "https://crawlgraph.com/mcp/../mcp/connectors", `${RESOURCE}/`]) error(await f.exchange(id, { resource }), 400, "invalid_target");
  error(await f.request("/oauth/token", { client_id: id, grant_type: "authorization_code", code: "fixture-code", code_verifier: VERIFIER }), 400, "invalid_target");
  error(await f.request("/oauth/token", { client_id: id, grant_type: "authorization_code", code: "fixture-code", resource: RESOURCE }), 400, "invalid_request");
  assert.equal(f.calls.filter(c => c.path.endsWith("/code")).length, count);
});

test("refresh omissions remain omitted and explicit scope/resource are validated before RPC", async t => {
  const f = await fixture(t); const body = { client_id: await f.client(), grant_type: "refresh_token", refresh_token: REFRESH };
  assert.equal((await f.request("/oauth/token", body)).status, 200);
  for (const key of ["resource", "scopes"]) assert.equal(Object.hasOwn(f.calls.at(-1).body, key), false);
  assert.equal((await f.request("/oauth/token", { ...body, scope: SCOPE, resource: RESOURCE })).status, 200);
  assert.deepEqual(f.calls.at(-1).body.scopes, [SCOPE]); assert.equal(f.calls.at(-1).body.resource, RESOURCE);
  error(await f.request("/oauth/token", { ...body, scope: "admin" }), 400, "invalid_scope");
  error(await f.request("/oauth/token", { ...body, resource: "https://crawlgraph.com:443/mcp/connectors" }), 400, "invalid_target");
  assert.equal(f.calls.filter(c => c.path.endsWith("/refresh")).length, 2);
});

test("public form revocation forwards validated client/token without public credentials in results", async t => {
  const f = await fixture(t); const id = await f.client();
  const r = await f.request("/oauth/revoke", { client_id: id, token: ACCESS, token_type_hint: "access_token" });
  assert.equal(r.status, 200); assert.deepEqual(r.body, {}); noCredentials(r);
  assert.deepEqual(f.calls.at(-1).body, { client_id: id, token: ACCESS, source: SOURCE, source_verified: true });
});

test("malformed credential-bearing request bodies do not leak credentials in responses or logs", async t => {
  const logs = [];
  t.mock.method(console, "error", (...values) => logs.push(values.map(String).join(" ")));
  const f = await fixture(t);
  for (const path of ["/oauth/register", "/mcp/connectors"]) {
    const body = `{"secret":"${SECRET}","token":"${ACCESS}","code":"fixture-code",`;
    const r = await f.raw(path, ["X-Forwarded-For", SOURCE, "Authorization", `Bearer ${ACCESS}`,
      "Content-Type", "application/json", "Content-Length", String(Buffer.byteLength(body))], body);
    error(r, 400, "invalid_request"); noCredentials(r);
    assert.equal(r.headers.get("www-authenticate"), null);
  }
  noCredentials({ text: logs.join("\n") });
  httpTelemetry(logs, [
    { category: "oauth_register", status: 400, code: "invalid_request" },
    { category: "connector", status: 400, code: "invalid_request" },
  ]);
  assert.equal(f.calls.filter(c => c.path.endsWith("/execute")).length, 0);
});

test("client lookup failures cross real SDK handlers as503/RetryAfter5, ordinary400 and429 actual RetryAfter", async t => {
  const f = await fixture(t); const id = await f.client();
  for (const failure of [{ status: 503, code: "temporarily_unavailable" }, { status: 400, code: "invalid_request" }, { status: 429, code: "rate_limited", retry: 37 }]) {
    f.state.lookupFailure = failure;
    for (const r of [await f.exchange(id), await f.request("/oauth/token", { client_id: id, grant_type: "refresh_token", refresh_token: REFRESH }),
      await f.request("/oauth/revoke", { client_id: id, token: ACCESS })]) {
      error(r, failure.status, failure.code === "rate_limited" ? "too_many_requests" : failure.code);
      assert.equal(r.headers.get("retry-after"), failure.status === 503 ? "5" : failure.retry ? "37" : null);
      assert.equal(r.headers.get("www-authenticate"), null); noCredentials(r);
    }
  }
  assert.equal(f.calls.filter(c => /\/tokens\/(code|refresh|revoke)$/.test(c.path)).length, 0);
});

test("ingress requires the exact socket peer and a single valid source header", async t => {
  const wrongPeer = await fixture(t, { peer: "127.0.0.2" });
  error(await wrongPeer.request("/mcp/connectors"), 503, "temporarily_unavailable");
  assert.equal(wrongPeer.calls.length, 0);
  const f = await fixture(t);
  for (const headers of [[], ["X-Forwarded-For", SOURCE, "X-Forwarded-For", SOURCE], ["X-Forwarded-For", `${SOURCE}, 198.51.100.22`], ["X-Forwarded-For", "invalid"]]) {
    for (const path of ["/mcp/connectors", "/oauth/token"]) {
      const r = await f.raw(path, headers); error(r, 503, "temporarily_unavailable"); assert.equal(r.headers.get("www-authenticate"), null);
    }
  }
  assert.equal(f.calls.length, 0);
});

test("connector accepts header-only bearer; API keys/query config and duplicate Authorization fail before introspection", async t => {
  const f = await fixture(t);
  for (const query of ["access_token=x", "apiKey=cg_live_fixture", "config=e30=", "apiKey.value=x", "config[x]=x", "ACCESS_TOKEN=x"]) {
    const r = await f.request(`/mcp/connectors?${query}`, undefined, { headers: { authorization: `Bearer ${ACCESS}` } });
    error(r, 401, "invalid_token"); assert.equal(r.headers.get("www-authenticate"), `${CHALLENGE_HEADER}, error="invalid_token"`); noCredentials(r);
  }
  for (const authorization of ["Bearer cg_live_fixture", `Basic ${ACCESS}`, `Bearer ${ACCESS}, Bearer ${OTHER_ACCESS}`]) error(await f.request("/mcp/connectors", undefined, { headers: { authorization } }), 401, "invalid_token");
  const r = await f.raw("/mcp/connectors", ["X-Forwarded-For", SOURCE, "Authorization", `Bearer ${ACCESS}`, "authorization", `Bearer ${OTHER_ACCESS}`]);
  error(r, 401, "invalid_token"); assert.equal(f.calls.length, 0);
});

test("revocation after introspection appears in actual HTTP CallToolResult metadata; backend503 never requests relink", async t => {
  const f = await fixture(t);
  for (const failure of [{ status: 401, code: "invalid_token" }, { status: 503, code: "temporarily_unavailable" }]) {
    f.state.executionFailure = failure;
    const r = await f.tool(); assert.equal(r.status, 200); assert.equal(r.body.id, 1);
    const result = r.body.result; assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, failure.code);
    if (failure.status === 401) assert.deepEqual(result._meta["mcp/www_authenticate"], [`${CHALLENGE_HEADER}, error="invalid_token"`]);
    else assert.equal(Object.hasOwn(result._meta, "mcp/www_authenticate"), false);
    assert.equal(r.headers.get("www-authenticate"), null); noCredentials(r);
    assert.deepEqual(f.calls.slice(-2).map(c => c.path), ["/internal/mcp/tokens/introspect", "/internal/mcp/operations/execute"]);
  }
});

test("concurrent owners/grants execute only fixed private RPCs with isolated credentials, verified sources and results", async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => f.tool(index % 2 ? OTHER_ACCESS : ACCESS, index % 2 ? "198.51.100.22" : SOURCE, index + 1)));
  for (const [index, r] of results.entries()) {
    assert.equal(r.status, 200); assert.equal(r.body.id, index + 1);
    const data = r.body.result.structuredContent;
    assert.equal(data.status, "complete"); assert.equal(data.data.releases[0].id, index % 2 ? "owner-22" : "owner-11");
    assert.equal(data.data.releases[0].label, index % 2 ? "Result for grant_b" : "Result for grant_a"); noCredentials(r);
  }
  const executions = f.calls.filter(c => c.path.endsWith("/execute")); assert.equal(executions.length, 8);
  assert.equal(f.calls.filter(c => c.path.endsWith("/introspect")).length, 8);
  for (const call of executions) {
    const other = call.headers.authorization === `Bearer ${OTHER_ACCESS}`;
    assert.equal(call.headers.authorization, `Bearer ${other ? OTHER_ACCESS : ACCESS}`);
    assert.equal(call.headers["x-crawlgraph-service-token"], SECRET);
    assert.deepEqual(call.body, { operation: "releases", source: other ? "198.51.100.22" : SOURCE, source_verified: true });
  }
  assert.equal(f.destinations.length, 16);
  for (const { url, init } of f.destinations) {
    assert.match(url, /^http:\/\/backend:8000\/internal\/mcp\/(tokens\/introspect|operations\/execute)$/);
    assert.equal(url.includes("/api/v1"), false); assert.equal(init.method, "POST");
  }
});

test("socket-free HTTP and SDK errors emit one safe line per response without credentials, raw paths, state, exception text or stdout", async t => {
  const logs = [], stdout = [], expected = [];
  t.mock.method(console, "error", (...values) => { assert.equal(values.length, 1); logs.push(values[0]); });
  t.mock.method(console, "log", (...values) => { stdout.push(values.map(String).join(" ")); });
  const f = await inProcessFixture();
  const state = `private-state-${ACCESS}`, reviewerMarker = "private-reviewer-password", domain = "private-query.example";
  const exception = `private-backend-exception ${SECRET} ${REFRESH} ${reviewerMarker} ${domain}`;
  const callerId = "private-caller-request-id";
  const headers = { "x-request-id": callerId, cookie: `reviewer=${reviewerMarker}`, authorization: `Bearer ${ACCESS}` };
  const check = async (operation, category, status, code) => {
    const before = logs.length;
    const response = await operation();
    assert.equal(response.status, status);
    assert.equal(logs.length, before + 1);
    expected.push({ category, status, code });
    return response;
  };
  await check(() => f.request(`/mcp/connectors?private=${ACCESS}`, { headers: { "x-request-id": callerId } }), "connector", 401, "missing_bearer");
  await check(() => f.request("/mcp/connectors", { headers, peer: "127.0.0.2" }), "connector", 503, "untrusted_peer");
  await check(() => f.post("/oauth/token", { client_id: "private-unknown-client", grant_type: "refresh_token", refresh_token: REFRESH }, false, headers), "oauth_token", 400, "invalid_client");
  const registered = await f.post("/oauth/register", { redirect_uris: [CALLBACK] }, true, headers);
  assert.equal(registered.status, 201);
  const id = registered.body.client_id;
  await check(() => f.post("/oauth/token", { client_id: id, grant_type: "authorization_code", code: "fixture-code",
    code_verifier: VERIFIER, resource: RESOURCE }, false, headers), "oauth_token", 400, "invalid_grant");
  await check(() => f.request("/oauth/register", { method: "POST", body: `{"secret":"${SECRET}","password":"${reviewerMarker}",`,
    headers: { ...headers, "content-type": "application/json" } }), "oauth_register", 400, "invalid_request");
  await check(() => f.request("/mcp/connectors", { method: "POST", body: `{"job_id":"private-job-id","domain":"${domain}",`,
    headers: { ...headers, "content-type": "application/json" } }), "connector", 400, "invalid_request");
  const redirect = await check(() => f.request(`/oauth/authorize?${new URLSearchParams({ client_id: id, redirect_uri: CALLBACK,
    response_type: "code", code_challenge: CHALLENGE, code_challenge_method: "plain", resource: RESOURCE, state })}`, { headers }),
    "oauth_authorize", 302, "invalid_request");
  redirectError(redirect, "invalid_request", state);
  f.state.failure = exception;
  f.state.failurePath = "/authorizations/begin";
  const unavailableRedirect = await check(() => f.request(`/oauth/authorize?${new URLSearchParams({ client_id: id, redirect_uri: CALLBACK,
    response_type: "code", code_challenge: CHALLENGE, code_challenge_method: "S256", resource: RESOURCE, state })}`, { headers }),
    "oauth_authorize", 503, "temporarily_unavailable");
  assert.equal(unavailableRedirect.headers.get("location"), null);
  assert.equal(unavailableRedirect.headers.get("retry-after"), "5");
  f.state.failure = null;
  f.state.failurePath = null;
  await check(() => f.post("/oauth/register", { redirect_uris: [`${CALLBACK}?secret=${SECRET}`], client_name: reviewerMarker }, true, headers),
    "oauth_register", 400, "invalid_client_metadata");
  const hugeToken = `private-revoke-${"x".repeat(257)}`;
  const revokes = f.calls.filter(call => call.path.endsWith("/tokens/revoke")).length;
  await check(() => f.post("/oauth/revoke", { client_id: id, token: hugeToken }, false, headers), "oauth_revoke", 400, "invalid_request");
  assert.equal(f.calls.filter(call => call.path.endsWith("/tokens/revoke")).length, revokes);
  f.state.failure = exception;
  await check(() => f.post("/oauth/token", { client_id: id, grant_type: "refresh_token", refresh_token: REFRESH }, false, headers),
    "oauth_token", 503, "temporarily_unavailable");
  await check(() => f.request(`/oauth/${reviewerMarker}?state=${state}`, { peer: "127.0.0.2", headers }), "oauth_other", 503, "untrusted_peer");
  await check(() => f.request("/mcp/connectors", { headers }), "connector", 503, "temporarily_unavailable");
  const disabled = await createApp({ env: { CONNECTOR_ENABLED: "false" } });
  await check(() => inProcessRequest(disabled, "/.well-known/oauth-authorization-server"), "authorization_metadata", 503, "disabled");
  await check(() => inProcessRequest(disabled, "/.well-known/oauth-protected-resource/mcp/connectors"), "resource_metadata", 503, "disabled");
  httpTelemetry(logs, expected);
  for (const marker of [ACCESS, OTHER_ACCESS, SECRET, REFRESH, VERIFIER, "fixture-code", reviewerMarker, domain, state, callerId,
    CALLBACK, SOURCE, exception, hugeToken, id, "private-job-id", "private-unknown-client", "private-grant-id", "private-family-id"]) {
    assert.equal(logs.join("\n").includes(marker), false);
  }
  assert.deepEqual(stdout, []);
  t.mock.method(console, "error", () => { throw new Error(exception); });
  error(await f.request("/mcp/connectors"), 401, "invalid_token");
});

test("socket-free protected catch after headers and repeated error logging cannot duplicate a response line", async t => {
  const logs = [];
  t.mock.method(console, "error", line => logs.push(line));
  const app = express();
  const backend = { introspect: async () => ({ user_id: 11, tier: "free", auth_kind: "account", grant_id: "private-grant-id",
    client_id: "private-client-id", family_id: "private-family-id", resource: RESOURCE, scopes: [SCOPE],
    expires_at: 4102444800, grant_expires_at: 4102444800 }) };
  const options = { enabled: true, backend, trustedPeers: new Set(["127.0.0.1"]), redirectUris: new Set([CALLBACK]) };
  app.all("/mcp/connectors", protectedConnectorHandler(options, async (_req, res) => {
    res.status(200).end("fixed partial response");
    throw new Error(`private-backend-exception ${ACCESS} ${SECRET}`);
  }));
  const r = await inProcessRequest(app, "/mcp/connectors", { headers: { authorization: `Bearer ${ACCESS}` } });
  assert.equal(r.status, 200);
  httpTelemetry(logs, [{ category: "connector", status: 200, code: "temporarily_unavailable" }]);
  const duplicate = express();
  duplicate.get("/fixed", (_req, res) => {
    sendConnectorError(res, new Error(SECRET));
    sendConnectorError(res, new Error(ACCESS));
  });
  // The second response send throws ERR_HTTP_HEADERS_SENT; a terminal handler
  // keeps Express's default raw error logger out of this deliberate fixture.
  duplicate.use((_error, _req, _res, _next) => {});
  const response = await inProcessRequest(duplicate, "/fixed");
  assert.equal(response.status, 503);
  assert.equal(logs.length, 2);
  httpTelemetry(logs, [
    { category: "connector", status: 200, code: "temporarily_unavailable" },
    { category: "unknown", status: 503, code: "temporarily_unavailable" },
  ]);
});

test("socket-free IPv6 compression and rotating hosts share only a /64 admission key, adjacent prefixes and mapped IPv4 stay independent", async t => {
  t.mock.method(console, "error", () => {});
  t.mock.method(performance, "now", () => 1000);
  const f = await inProcessFixture();
  const register = await f.post("/oauth/register", { redirect_uris: [CALLBACK] }, true);
  const id = register.body.client_id;
  const sources = ["2001:db8:1::1", "2001:0db8:0001:0000:abcd:0000:0000:0002", "2001:db8:1:0:ffff::3"];
  const canonical = ["2001:db8:1::1", "2001:db8:1:0:abcd::2", "2001:db8:1:0:ffff::3"];
  for (const [i, source] of sources.entries()) {
    assert.equal((await f.post("/oauth/revoke", { client_id: id, token: ACCESS }, false, { "x-forwarded-for": source })).status, 200);
    assert.equal(f.calls.at(-1).body.source, canonical[i], "RPC gets the full normalized verified ingress source");
    assert.equal(f.calls.at(-1).body.source_verified, true);
  }
  for (let i = 0; i < 100; i++) {
    const source = i % 2 ? sources[1] : `2001:db8:1::${(i + 1).toString(16)}`;
    error(await f.request("/oauth/authorize?client_id=unknown", { headers: { "x-forwarded-for": source } }), 400, "invalid_client");
  }
  const lookups = f.calls.length;
  throttle(await f.request("/oauth/authorize?client_id=unknown", { headers: { "x-forwarded-for": sources[2] } }), 900);
  assert.equal(f.calls.length, lookups);
  error(await f.request("/oauth/authorize?client_id=unknown", { headers: { "x-forwarded-for": "2001:db8:1:1::1" } }), 400, "invalid_client");
  for (let i = 0; i < 100; i++) {
    error(await f.request("/oauth/authorize?client_id=unknown", { headers: { "x-forwarded-for": `2001::${(i + 1).toString(16)}` } }), 400, "invalid_client");
  }
  throttle(await f.request("/oauth/authorize?client_id=unknown", { headers: { "x-forwarded-for": "2001:0:0:0:ffff::1" } }), 900);
  error(await f.request("/oauth/authorize?client_id=unknown", { headers: { "x-forwarded-for": "2001:0:0:1::1" } }), 400, "invalid_client");
  for (let i = 0; i < 100; i++) error(await f.request("/oauth/authorize?client_id=unknown"), 400, "invalid_client");
  throttle(await f.request("/oauth/authorize?client_id=unknown", { headers: { "x-forwarded-for": `::ffff:${SOURCE}` } }), 900);
  assert.equal((await f.post("/oauth/revoke", { client_id: id, token: ACCESS }, false, { "x-forwarded-for": `::ffff:${SOURCE}` })).status, 200);
  assert.equal(f.calls.at(-1).body.source, SOURCE);
  error(await f.request("/oauth/authorize?client_id=unknown", { headers: { "x-forwarded-for": "::ffff:203.0.113.20" } }), 400, "invalid_client");
  const ingress = verifiedIngress({ socket: { remoteAddress: "127.0.0.1" }, rawHeaders: ["X-Forwarded-For", canonical[1]],
    headers: { "x-forwarded-for": canonical[1] } }, new Set(["127.0.0.1"]));
  let rpc;
  const backend = new BackendClient(SECRET, async (_url, init) => { rpc = JSON.parse(init.body); return Response.json({ status: "ok" }); });
  await backend.revoke(id, ACCESS, ingress);
  assert.equal(rpc.source, ingress.source);
  assert.equal(ingress.source, canonical[1]);
});

test("socket-free startup diagnostics use exact fixed reasons and unknown secret-bearing messages stay generic while startup fails closed", async t => {
  const logs = [], stdout = [];
  t.mock.method(console, "error", (...values) => { assert.equal(values.length, 1); logs.push(values[0]); });
  t.mock.method(console, "log", (...values) => { stdout.push(values.map(String).join(" ")); });
  const base = { CONNECTOR_ENABLED: "true", CONNECTOR_SERVICE_SECRET: SECRET, CONNECTOR_REDIRECT_URIS: CALLBACK,
    CONNECTOR_NGINX_PEER_IPS: "127.0.0.1" };
  const reasons = [];
  for (const [env, reason, resolver] of [
    [{ CONNECTOR_ENABLED: "invalid" }, "Invalid CONNECTOR_ENABLED configuration"],
    [{ CONNECTOR_SERVICE_SECRET: "" }, "Invalid CONNECTOR_SERVICE_SECRET configuration"],
    [{ CONNECTOR_ISSUER: "https://invalid.example" }, "Invalid CONNECTOR_ISSUER configuration"],
    [{ CONNECTOR_RESOURCE: "https://invalid.example" }, "Invalid CONNECTOR_RESOURCE configuration"],
    [{ CONNECTOR_SCOPE: "invalid" }, "Invalid CONNECTOR_SCOPE configuration"],
    [{ CONNECTOR_REDIRECT_URIS: "invalid" }, "Invalid CONNECTOR_REDIRECT_URIS configuration"],
    [{ CONNECTOR_NGINX_PEER_IPS: "invalid" }, "Invalid CONNECTOR_NGINX_PEER_IPS configuration"],
    [{}, "Connector nginx peer verification unavailable", async () => { throw new Error(SECRET); }],
    [{}, "Connector nginx peer configuration mismatch", async () => ["127.0.0.2"]],
    [{ MCP_PATH: "/oauth/secret" }, "MCP_PATH conflicts with connector surface"],
  ]) {
    await assert.rejects(createApp({ env: { ...base, ...env }, resolveNginxPeers: resolver ?? (async () => ["127.0.0.1"]) }), failure => {
      assert.equal(failure.message, reason); logStartupFailure(failure); return true;
    });
    reasons.push(reason);
  }
  for (const message of [SECRET, `Invalid CONNECTOR_SERVICE_SECRET configuration ${SECRET}`,
    `Connector nginx peer configuration mismatch: ${ACCESS}`, `MCP_PATH conflicts with connector surface ${REFRESH}`]) {
    logStartupFailure(new Error(message)); reasons.push("startup_failure");
  }
  assert.equal(logs.length, reasons.length);
  for (const [i, line] of logs.entries()) {
    const record = JSON.parse(line);
    assert.deepEqual(Object.keys(record).sort(), ["event", "request_id", "status", "code"].sort());
    assert.equal(record.event, "connector_startup"); assert.equal(record.status, "error");
    assert.equal(record.code, reasons[i]);
    assert.match(record.request_id, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  }
  noCredentials({ text: logs.join("\n") });
  assert.deepEqual(stdout, []);
  // Runtime schema refuses widened fields and overlong arrays, even in JS.
  const before = logs.length;
  logConnectorTelemetry({ event: "connector_startup", request_id: JSON.parse(logs[0]).request_id, status: "error",
    code: "startup_failure", message: SECRET });
  logConnectorTelemetry({ event: "connector_tool", request_id: JSON.parse(logs[0]).request_id, tool: "unknown",
    status: "error", isError: true, code: "not_found", latency_ms: 0, result_bytes: 1, known_charged_calls: 0,
    unknown_consumption_categories: [], partial_codes: Array(9).fill("not_found") });
  assert.equal(logs.length, before);
  t.mock.method(console, "error", () => { throw new Error(SECRET); });
  assert.doesNotThrow(() => logStartupFailure(new Error(SECRET)));
});

test("socket-free tool telemetry and failing startup subprocesses keep actual stdout empty", () => {
  const script = `
    import { Client } from '@modelcontextprotocol/sdk/client/index.js';
    import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
    import { buildDirectoryServer } from './dist/server.js';
    import { verifiedIngress } from './dist/backend-client.js';
    const marker = 'private-subprocess-marker';
    const ingress = verifiedIngress({ socket: { remoteAddress: '127.0.0.1' },
      rawHeaders: ['X-Forwarded-For', '203.0.113.19'], headers: { 'x-forwarded-for': '203.0.113.19' } }, new Set(['127.0.0.1']));
    const server = buildDirectoryServer({ auth: { token: marker }, ingress, signal: new AbortController().signal },
      { execute: async () => ({ operation: 'releases', status: 'complete', error: null, quota: [],
        quota_consumed: { category: null, count: 0 }, data: { releases: [{ id: 'cc-a', label: marker, available: true }] } }) });
    const client = new Client({ name: marker, version: '1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), server.connect(st)]);
    await client.callTool({ name: 'releases', arguments: {} });
    await client.callTool({ name: 'backlinks', arguments: { domain: marker } });
    await client.callTool({ name: marker, arguments: { token: marker } });
    await client.close(); await server.close();
  `;
  const tool = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  assert.ifError(tool.error);
  assert.equal(tool.status, 0, tool.stderr);
  assert.equal(tool.stdout, "");
  const lines = tool.stderr.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map(line => [line.event, line.tool, line.status, line.code]), [
    ["connector_tool", "releases", "complete", null], ["connector_tool", "backlinks", "error", "validation_error"],
    ["connector_tool", "unknown", "error", "not_found"],
  ]);
  assert.equal(tool.stderr.includes("private-subprocess-marker"), false);
  const startup = spawnSync(process.execPath, ["dist/http.js"], { cwd: new URL("..", import.meta.url),
    env: { CONNECTOR_ENABLED: "true", CONNECTOR_SERVICE_SECRET: "" }, encoding: "utf8" });
  assert.ifError(startup.error);
  assert.equal(startup.status, 1);
  assert.equal(startup.stdout, "");
  assert.equal(startup.stderr.trim().split("\n").length, 1);
  const record = JSON.parse(startup.stderr);
  assert.deepEqual(Object.keys(record).sort(), ["event", "request_id", "status", "code"].sort());
  assert.equal(record.event, "connector_startup"); assert.equal(record.status, "error");
  assert.equal(record.code, "Invalid CONNECTOR_SERVICE_SECRET configuration");
});
