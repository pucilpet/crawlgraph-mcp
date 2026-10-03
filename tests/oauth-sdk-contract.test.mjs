import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import express from "express";
import { clientRegistrationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/register.js";
import { authorizationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import { revocationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/revoke.js";
import { tokenHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/token.js";
import { mcpAuthMetadataRouter, createOAuthMetadata } from "@modelcontextprotocol/sdk/server/auth/router.js";
import {
  AccessDeniedError, InvalidClientMetadataError, InvalidGrantError,
  InvalidRequestError, InvalidScopeError, InvalidTargetError,
  TemporarilyUnavailableError, TooManyRequestsError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";

// Acceptance fixtures only: no production routes, login, CIMD, or platform calls.
const ISSUER = "https://crawlgraph.com";
const RESOURCE = `${ISSUER}/mcp/connectors`;
const SCOPE = "crawlgraph:read";
const CLAUDE = "https://claude.ai/api/mcp/auth_callback";
// Deliberately fake hosted callback; this proves no actual platform compatibility.
// OpenAI's production callback remains portal-owned and unconfigured.
const FAKE = "https://fake-client.example.test/oauth/callback";
const ALLOWED = new Set([CLAUDE, FAKE]);
const VERIFIER = "v".repeat(43);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const METADATA = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/oauth/authorize`,
  token_endpoint: `${ISSUER}/oauth/token`,
  registration_endpoint: `${ISSUER}/oauth/register`,
  revocation_endpoint: `${ISSUER}/oauth/revoke`,
  revocation_endpoint_auth_methods_supported: ["none"],
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
  scopes_supported: [SCOPE],
  client_id_metadata_document_supported: false,
};
const FAKE_ACCESS = "fake-access";
const FAKE_REFRESH = "fake-refresh";
const TOKENS = { access_token: FAKE_ACCESS, token_type: "Bearer", expires_in: 300, refresh_token: FAKE_REFRESH, scope: SCOPE };

async function fixture(t, { seams = true } = {}) {
  const clients = new Map();
  const calls = { registrations: [], authorize: [], exchange: [], refresh: [], revoke: [], lookups: [], challenge: 0 };
  const backend = { failure: undefined, accountExists: true, consumed: false, redirectUri: undefined };
  const failIfRequested = () => { if (backend.failure) throw backend.failure; };
  const requireResource = resource => {
    if (resource?.href !== RESOURCE) throw new InvalidTargetError("Exact resource required");
  };
  const clientsStore = {
    getClient: async id => {
      calls.lookups.push(id);
      failIfRequested();
      return clients.get(id); // URL-shaped IDs never trigger CIMD fetch.
    },
    registerClient: async info => {
      calls.registrations.push({ ...info });
      failIfRequested();
      if (info.token_endpoint_auth_method !== undefined && info.token_endpoint_auth_method !== "none") {
        throw new InvalidClientMetadataError("Public clients only");
      }
      if (!info.redirect_uris.length || info.redirect_uris.some(uri => !ALLOWED.has(uri))) {
        throw new InvalidClientMetadataError("Exact allowlisted hosted HTTPS callbacks required");
      }
      // SDK creates a secret for omission. Normalize deliberately inside the store,
      // stripping both generated secret fields before persistence AND response.
      const { client_secret, client_secret_expires_at, ...publicInfo } = info;
      const stored = { ...publicInfo, token_endpoint_auth_method: "none" };
      clients.set(stored.client_id, stored);
      return stored;
    },
  };
  const provider = {
    clientsStore,
    skipLocalPkceValidation: true,
    authorize: async (client, params, res) => {
      // SDK forwards omitted authorization scope as an empty array.
      if (params.scopes.length === 0) params.scopes = [SCOPE];
      calls.authorize.push({ client, ...params });
      failIfRequested();
      requireResource(params.resource);
      if (params.scopes.length !== 1 || params.scopes[0] !== SCOPE) throw new InvalidScopeError("Exact scope required");
      if (!backend.accountExists) throw new AccessDeniedError("Existing accounts only");
      backend.redirectUri = params.redirectUri;
      const location = new URL(params.redirectUri);
      location.searchParams.set("code", "fake-code");
      if (params.state !== undefined) location.searchParams.set("state", params.state);
      res.redirect(302, location.href);
    },
    challengeForAuthorizationCode: async () => { calls.challenge++; throw new Error("Local PKCE must be skipped"); },
    exchangeAuthorizationCode: async (client, code, verifier, redirect, resource) => {
      calls.exchange.push({ client, code, verifier, redirect, resource });
      failIfRequested();
      requireResource(resource);
      // Isolated fake atomic boundary. Durable backend correctness comes later;
      // these checks prove handler forwarding, not concurrency/persistence safety.
      if (client.client_id !== backend.clientId || code !== "fake-code" || backend.consumed ||
          createHash("sha256").update(verifier).digest("base64url") !== CHALLENGE ||
          (redirect !== undefined && redirect !== backend.redirectUri)) {
        throw new InvalidGrantError("Invalid exchange binding");
      }
      const callback = redirect ?? backend.redirectUri;
      calls.exchange.at(-1).resolvedRedirect = callback;
      backend.consumed = true;
      return TOKENS;
    },
    revokeToken: async (client, request) => {
      calls.revoke.push({ client, request });
      failIfRequested();
    },
    exchangeRefreshToken: async (client, token, scopes, resource) => {
      calls.refresh.push({ client, token, scopes, resource });
      failIfRequested();
      if (token !== "fake-refresh" || client.client_id !== backend.clientId) throw new InvalidGrantError("Invalid refresh binding");
      // Omission retains the stored grant; explicit values must match it.
      if (scopes !== undefined && (scopes.length !== 1 || scopes[0] !== SCOPE)) throw new InvalidScopeError("Scope escalation");
      if (resource !== undefined) requireResource(resource);
      return TOKENS;
    },
  };
  const app = express(); // Project's root Express 4, SDK internally uses Express 5 routers.
  app.use(express.json());
  // Parse POST inputs for request provenance; SDK retains all protocol validation.
  app.use("/oauth/authorize", express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    const authorizationParams = req.method === "POST" ? req.body : req.query;
    if (seams) {
      // Typed adapter errors must survive SDK's internal catch/serialization.
      // A per-response provider/store proxy records identity; ordinary 400s stay 400.
      const json = res.json.bind(res);
      res.json = body => {
        if (res.locals.domainError instanceof TemporarilyUnavailableError) res.status(503).set("Retry-After", "5");
        else if (res.locals.domainError instanceof TooManyRequestsError) res.status(429).set("Retry-After", "60");
        return json(body);
      };
      const redirect = res.redirect.bind(res);
      res.redirect = (status, location) => {
        const url = new URL(location);
        const callback = location.split("?")[0];
        const client = clients.get(authorizationParams?.client_id);
        // SDK validates the redirect first; seam restores state only to a callback
        // that is both globally allowlisted and registered to this client.
        if (url.searchParams.has("error") && ALLOWED.has(callback) && client?.redirect_uris.includes(callback) && typeof authorizationParams?.state === "string") {
          url.searchParams.set("state", authorizationParams.state);
        }
        return redirect(status, url.href);
      };
    }
    const capture = object => new Proxy(object, {
      get(target, key) {
        const value = target[key];
        if (typeof value !== "function") return value;
        return async (...args) => {
          try { return await value(...args); }
          catch (error) { res.locals.domainError = error; throw error; }
        };
      },
    });
    const requestStore = capture(clientsStore);
    res.locals.provider = capture({ ...provider, clientsStore: requestStore });
    res.locals.store = requestStore;
    next();
  });
  app.use(mcpAuthMetadataRouter({ oauthMetadata: METADATA, resourceServerUrl: new URL(RESOURCE), scopesSupported: [SCOPE] }));
  // Mount actual exported SDK handlers, never reimplement public OAuth parsing.
  app.use("/oauth/register", (req, res, next) => clientRegistrationHandler({ clientsStore: res.locals.store, rateLimit: false })(req, res, next));
  app.use("/oauth/authorize", (req, res, next) => authorizationHandler({ provider: res.locals.provider, rateLimit: false })(req, res, next));
  app.use("/oauth/token", (req, res, next) => tokenHandler({ provider: res.locals.provider, rateLimit: false })(req, res, next));
  app.use("/oauth/revoke", (req, res, next) => revocationHandler({ provider: res.locals.provider, rateLimit: false })(req, res, next));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, body, json = false) => {
    const response = await fetch(`${base}${path}`, {
      redirect: "manual", // Never follow fake/Claude/issuer URLs or call a provider.
      ...(body === undefined ? {} : { method: "POST", headers: { "content-type": json ? "application/json" : "application/x-www-form-urlencoded" }, body: json ? JSON.stringify(body) : new URLSearchParams(body) }),
    });
    return { status: response.status, headers: response.headers, body: response.headers.get("content-type")?.includes("application/json") ? await response.json() : await response.text() };
  };
  const register = async metadata => request("/oauth/register", { redirect_uris: [FAKE], ...metadata }, true);
  const client = async () => {
    const result = await register({ token_endpoint_auth_method: "none" });
    assert.equal(result.status, 201);
    backend.clientId = result.body.client_id;
    return result.body.client_id;
  };
  const auth = (id, overrides = {}) => request(`/oauth/authorize?${new URLSearchParams({ client_id: id, redirect_uri: FAKE, response_type: "code", code_challenge: CHALLENGE, code_challenge_method: "S256", resource: RESOURCE, scope: SCOPE, state: "state + / &", ...overrides })}`);
  const exchange = (id, overrides = {}) => request("/oauth/token", { client_id: id, grant_type: "authorization_code", code: "fake-code", code_verifier: VERIFIER, redirect_uri: FAKE, resource: RESOURCE, ...overrides });
  return { request, register, client, auth, exchange, clients, calls, backend, provider };
}

function oauthError(result, status, code) {
  assert.equal(result.status, status);
  assert.equal(result.body.error, code);
  assert.equal(result.headers.get("location"), null);
}
function redirectedError(result, code, state = "state + / &") {
  assert.equal(result.status, 302);
  const url = new URL(result.headers.get("location"));
  assert.equal(`${url.origin}${url.pathname}`, FAKE);
  assert.equal(url.searchParams.get("error"), code);
  assert.equal(url.searchParams.get("state"), state);
}

test("fixture runs tested SDK on root Express4 and explicit public-only metadata", async t => {
  const require = createRequire(import.meta.url);
  assert.match(require("express/package.json").version, /^4\./);
  const sdk = JSON.parse(await readFile(new URL("../node_modules/@modelcontextprotocol/sdk/package.json", import.meta.url), "utf8"));
  assert.equal(sdk.version, "1.29.0");
  const f = await fixture(t);
  assert.deepEqual((await f.request("/.well-known/oauth-authorization-server")).body, METADATA);
  assert.deepEqual((await f.request("/.well-known/oauth-protected-resource/mcp/connectors")).body, {
    resource: RESOURCE, authorization_servers: [ISSUER], scopes_supported: [SCOPE],
  });
  assert.deepEqual(createOAuthMetadata({ issuerUrl: new URL(ISSUER), provider: f.provider }).token_endpoint_auth_methods_supported, ["client_secret_post", "none"]);
});

test("DCR none and deliberate omission normalization are secret-free; confidential and unsafe metadata rejected", async t => {
  const f = await fixture(t);
  for (const metadata of [{ token_endpoint_auth_method: "none" }, {}]) {
    const result = await f.register(metadata);
    assert.equal(result.status, 201);
    assert.equal(result.body.token_endpoint_auth_method, "none");
    for (const info of [result.body, f.clients.get(result.body.client_id)]) {
      assert.equal(Object.hasOwn(info, "client_secret"), false);
      assert.equal(Object.hasOwn(info, "client_secret_expires_at"), false);
    }
  }
  assert.equal(f.calls.registrations[0].client_secret, undefined);
  assert.equal(typeof f.calls.registrations[1].client_secret, "string", "raw SDK omission generates a secret before the store seam");
  for (const method of ["client_secret_post", "client_secret_basic", "private_key_jwt"]) oauthError(await f.register({ token_endpoint_auth_method: method }), 400, "invalid_client_metadata");
  for (const callback of ["http://localhost/cb", "http://127.0.0.1:9999/cb", "https://evil.example/cb", `${FAKE}?x=1`, `${FAKE}#fragment`, "https://fake-client.example.test/oauth/*", "javascript:alert(1)"]) {
    oauthError(await f.register({ redirect_uris: [callback], token_endpoint_auth_method: "none" }), 400, "invalid_client_metadata");
  }
  assert.equal((await f.register({ redirect_uris: [CLAUDE], token_endpoint_auth_method: "none" })).status, 201);
});

test("authorization S256, resource, scope and existing-account policy; errors keep state only on registered safe redirects", async t => {
  const f = await fixture(t);
  const id = await f.client();
  assert.equal((await f.auth(id)).status, 302);
  const withoutRedirect = new URLSearchParams({ client_id: id, response_type: "code", code_challenge: CHALLENGE, code_challenge_method: "S256", resource: RESOURCE, scope: SCOPE });
  assert.equal((await f.request(`/oauth/authorize?${withoutRedirect}`)).status, 302);
  assert.equal(f.calls.authorize[1].redirectUri, FAKE);
  assert.equal(f.calls.authorize[0].codeChallenge, CHALLENGE);
  assert.equal(f.calls.authorize[0].resource.href, RESOURCE);
  assert.deepEqual(f.calls.authorize[0].scopes, [SCOPE]);
  withoutRedirect.delete("scope");
  assert.equal((await f.request(`/oauth/authorize?${withoutRedirect}`)).status, 302);
  assert.deepEqual(f.calls.authorize.at(-1).scopes, [SCOPE]);
  for (const method of ["plain", ""]) redirectedError(await f.auth(id, { code_challenge_method: method }), "invalid_request");
  redirectedError(await f.auth(id, { response_type: "token" }), "invalid_request");
  redirectedError(await f.auth(id, { resource: "malformed" }), "invalid_request");
  redirectedError(await f.auth(id, { code_challenge_method: "plain", state: "" }), "invalid_request", "");
  redirectedError(await f.auth(id, { resource: "https://wrong.example/resource" }), "invalid_target");
  const missingResource = new URLSearchParams({ client_id: id, response_type: "code", code_challenge: CHALLENGE, code_challenge_method: "S256", scope: SCOPE, state: "state + / &" });
  redirectedError(await f.request(`/oauth/authorize?${missingResource}`), "invalid_target");
  redirectedError(await f.auth(id, { scope: "admin" }), "invalid_scope");
  f.backend.accountExists = false;
  redirectedError(await f.auth(id), "access_denied");
  for (const redirect_uri of ["https://evil.example/cb", CLAUDE, `${FAKE}?changed=1`]) oauthError(await f.auth(id, { redirect_uri }), 400, "invalid_request");
  oauthError(await f.auth("https://metadata.example.test/client.json"), 400, "invalid_client");
  const multiple = await f.register({ redirect_uris: [FAKE, CLAUDE], token_endpoint_auth_method: "none" });
  missingResource.set("client_id", multiple.body.client_id);
  oauthError(await f.request(`/oauth/authorize?${missingResource}`), 400, "invalid_request");
});

test("POST authorization errors preserve body state even with conflicting query parameters", async t => {
  const f = await fixture(t);
  const id = await f.client();
  for (const state of ["body-state + &", ""]) {
    const result = await f.request(`/oauth/authorize?${new URLSearchParams({ client_id: id, state: "query-state" })}`, {
      client_id: id, redirect_uri: FAKE, response_type: "code", code_challenge: CHALLENGE,
      code_challenge_method: "plain", resource: RESOURCE, scope: SCOPE, state,
    });
    redirectedError(result, "invalid_request", state);
  }
  oauthError(await f.request(`/oauth/authorize?${new URLSearchParams({ client_id: id, state: "query-state" })}`, {
    client_id: id, redirect_uri: "https://evil.example/cb", state: "body-state",
  }), 400, "invalid_request");
});

test("raw SDK schema errors lose state: explicit seam required before production", async t => {
  const f = await fixture(t, { seams: false });
  const result = await f.auth(await f.client(), { code_challenge_method: "plain" });
  redirectedError(result, "invalid_request", null);
});

test("code exchange forwards verifier/resource/redirect to atomic boundary without local PKCE", async t => {
  const f = await fixture(t);
  const id = await f.client();
  assert.equal((await f.auth(id)).status, 302);
  assert.equal(f.backend.redirectUri, FAKE);
  for (const overrides of [{ code_verifier: "w".repeat(43) }, { redirect_uri: CLAUDE }, { resource: "https://wrong.example/resource" }]) {
    const result = await f.exchange(id, overrides);
    oauthError(result, 400, overrides.resource ? "invalid_target" : "invalid_grant");
    assert.equal(f.backend.consumed, false);
    if (overrides.code_verifier) assert.equal(f.calls.exchange.at(-1).verifier, overrides.code_verifier);
  }
  const other = (await f.register({ token_endpoint_auth_method: "none" })).body.client_id;
  oauthError(await f.exchange(other), 400, "invalid_grant");
  const omitted = { client_id: id, grant_type: "authorization_code", code: "fake-code", code_verifier: VERIFIER };
  oauthError(await f.request("/oauth/token", omitted), 400, "invalid_target");
  assert.equal(f.backend.consumed, false);
  oauthError(await f.exchange(id, { resource: "malformed" }), 400, "invalid_request");
  assert.equal(f.backend.consumed, false);
  const omittedRedirect = await f.request("/oauth/token", { ...omitted, resource: RESOURCE });
  assert.equal(omittedRedirect.status, 200);
  assert.deepEqual(omittedRedirect.body, TOKENS);
  const forwarded = f.calls.exchange.at(-1);
  assert.equal(forwarded.verifier, VERIFIER);
  assert.equal(forwarded.redirect, undefined);
  assert.equal(forwarded.resolvedRedirect, FAKE);
  assert.equal(forwarded.resource.href, RESOURCE);
  assert.equal(f.calls.challenge, 0);
  oauthError(await f.exchange(id), 400, "invalid_grant");
  f.backend.consumed = false;
  const authorization = { client_id: id, response_type: "code", code_challenge: CHALLENGE, code_challenge_method: "S256", scope: SCOPE, resource: RESOURCE };
  assert.equal((await f.request(`/oauth/authorize?${new URLSearchParams(authorization)}`)).status, 302);
  assert.equal(f.backend.redirectUri, FAKE);
  oauthError(await f.exchange(id, { redirect_uri: CLAUDE }), 400, "invalid_grant");
  assert.equal(f.backend.consumed, false);
  assert.equal((await f.request("/oauth/token", { ...omitted, resource: RESOURCE })).status, 200);
  assert.equal(f.calls.exchange.at(-1).redirect, undefined);
  assert.equal(f.calls.exchange.at(-1).resolvedRedirect, FAKE);
  f.backend.consumed = false;
  assert.equal((await f.exchange(id)).status, 200);
  assert.equal(f.calls.exchange.at(-1).redirect, FAKE);
  oauthError(await f.request("/oauth/token", { client_id: id, grant_type: "authorization_code", code: "fake-code", resource: RESOURCE }), 400, "invalid_request");
});

test("refresh omission forwards undefined scope/resource; explicit grant values and errors retained", async t => {
  const f = await fixture(t);
  const body = { client_id: await f.client(), grant_type: "refresh_token", refresh_token: FAKE_REFRESH };
  assert.deepEqual((await f.request("/oauth/token", body)).body, TOKENS);
  assert.equal(f.calls.refresh[0].scopes, undefined);
  assert.equal(f.calls.refresh[0].resource, undefined);
  assert.equal((await f.request("/oauth/token", { ...body, scope: SCOPE, resource: RESOURCE })).status, 200);
  assert.deepEqual(f.calls.refresh[1].scopes, [SCOPE]);
  assert.equal(f.calls.refresh[1].resource.href, RESOURCE);
  oauthError(await f.request("/oauth/token", { ...body, scope: "admin" }), 400, "invalid_scope");
  oauthError(await f.request("/oauth/token", { ...body, resource: "https://wrong.example/resource" }), 400, "invalid_target");
  oauthError(await f.request("/oauth/token", { ...body, grant_type: "client_credentials" }), 400, "unsupported_grant_type");
});

test("typed client lookup errors map to503 Retry-After5 and429 Retry-After60 through seam; SDK raw behavior and ordinary400 remain explicit", async t => {
  for (const seams of [false, true]) {
    const f = await fixture(t, { seams });
    const id = await f.client();
    assert.equal((await f.auth(id)).status, 302, "issue a bound code before lookup failures");
    for (const [error, expected] of [[new TemporarilyUnavailableError("Backend unavailable"), 503], [new TooManyRequestsError("Backend quota"), 429], [new InvalidRequestError("Normal invalid request"), 400]]) {
      f.backend.failure = error;
      for (const result of [await f.exchange(id), await f.register({ token_endpoint_auth_method: "none" }), await f.request("/oauth/token", { client_id: id, grant_type: "refresh_token", refresh_token: FAKE_REFRESH }), await f.request("/oauth/revoke", { client_id: id, token: FAKE_ACCESS })]) {
        oauthError(result, seams ? expected : 400, error.errorCode);
        assert.equal(result.headers.get("Retry-After"), seams ? (expected === 503 ? "5" : expected === 429 ? "60" : null) : null);
      }
      assert.equal(f.backend.consumed, false, "lookup failures must not consume a code");
      assert.equal(f.calls.exchange.length, 0, "token failure originates in client lookup");
      assert.equal(f.calls.refresh.length, 0);
      assert.equal(f.calls.revoke.length, 0, "revocation failure originates in client lookup");
      assert.ok(f.calls.lookups.includes(id));
    }
  }
});

test("public form revocation reaches the SDK provider without a client secret", async t => {
  const f = await fixture(t);
  const id = await f.client();
  const result = await f.request("/oauth/revoke", { client_id: id, token: FAKE_ACCESS, token_type_hint: "access_token" });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {});
  assert.equal(f.calls.revoke.length, 1);
  assert.equal(f.calls.revoke[0].client.client_id, id);
  assert.equal(Object.hasOwn(f.calls.revoke[0].client, "client_secret"), false);
  assert.deepEqual(f.calls.revoke[0].request, { token: FAKE_ACCESS, token_type_hint: "access_token" });
});
