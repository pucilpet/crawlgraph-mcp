#!/usr/bin/env node
/**
 * CrawlGraph MCP server — hosted HTTP entrypoint (Streamable HTTP transport).
 *
 * This is the multi-tenant remote server: it listens on HTTP and each request
 * carries the caller's own CrawlGraph API key in `Authorization: Bearer cg_live_…`.
 * That key is used only for that request's tool calls — there is no shared key.
 *
 * Stateless mode (sessionIdGenerator: undefined): every POST creates a fresh
 * server + transport bound to that request's key, handles it, and tears down.
 * Simple, isolated, and a perfect fit for per-request auth.
 *
 * Deployed behind nginx + Cloudflare at https://crawlgraph.com/mcp. The stdio
 * entrypoint (index.ts) and the published npm package are unaffected — they
 * share the same tool definitions from ./server.ts.
 */

import { lookup } from "node:dns/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import express from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer, buildDirectoryServer, VERSION } from "./server.js";
import {
  BackendClient, CONNECTOR_ISSUER, CONNECTOR_RESOURCE, CONNECTOR_SCOPE, normalizeIp, validateServiceSecret,
  connectorStartupReasonSchema, connectorRequestId, logConnectorTelemetry,
} from "./backend-client.js";
import {
  AUTHORIZATION_METADATA_PATH, CONNECTOR_PATH, RESOURCE_METADATA_PATH,
  createOAuthRouter, protectedConnectorHandler, sendConnectorError, parserErrorStatus, logConnectorHttpError,
  type ConnectorSurfaceOptions, type ProtectedConnectorContext,
} from "./oauth/router.js";

// Resolve the caller's CrawlGraph API key. Three sources, in priority order:
//   1. Authorization: Bearer <key>      — direct clients, Glama, the docs example
//   2. ?apiKey=<key>                     — Smithery passes session config as
//                                          dot-notation query params
//   3. ?config=<base64(JSON)>            — Smithery's packed-config form;
//                                          we read the `apiKey` field out of it
// Keeping the header first means nothing changes for existing clients.
function firstString(v: unknown): string {
  if (Array.isArray(v)) return typeof v[0] === "string" ? v[0] : "";
  return typeof v === "string" ? v : "";
}

function resolveApiKey(req: express.Request): string {
  const h = (req.headers["authorization"] || req.headers["Authorization" as any] || "") as string;
  const fromHeader = h.replace(/^Bearer\s+/i, "").trim();
  if (fromHeader) return fromHeader;

  const fromQuery = firstString(req.query?.apiKey).trim();
  if (fromQuery) return fromQuery;

  const packed = firstString(req.query?.config).trim();
  if (packed) {
    try {
      const cfg = JSON.parse(Buffer.from(packed, "base64").toString("utf8"));
      const k = typeof cfg?.apiKey === "string" ? cfg.apiKey.trim() : "";
      if (k) return k;
    } catch {
      /* malformed config blob — fall through to empty (tools return a clear auth error) */
    }
  }
  return "";
}

// Stateless mode doesn't use the GET (server->client SSE stream) or DELETE
// (session teardown) verbs — answer them per the MCP spec with 405.
const methodNotAllowed = (_req: express.Request, res: express.Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed. This server is stateless; use POST." },
    id: null,
  });
};

export type DirectoryServerFactory = (context: ProtectedConnectorContext) => McpServer | Promise<McpServer>;
export interface HttpAppOptions {
  env?: NodeJS.ProcessEnv;
  // Test seams are programmatic only; production always resolves the fixed Docker name.
  resolveNginxPeers?: (hostname: "nginx") => Promise<readonly string[]>;
  trustedNginxPeerIps?: readonly string[];
  backendFetch?: typeof fetch;
  directoryServerFactory?: DirectoryServerFactory;
}

function validRedirect(value: string): boolean {
  if (!value || value.length > 2048 || /[^\x21-\x7e]|[?#@*\\]/.test(value) || !value.startsWith("https://")) return false;
  try {
    const url = new URL(value);
    const rawAuthority = value.slice("https://".length).split("/")[0];
    const host = url.hostname;
    return value.slice("https://".length + rawAuthority.length).startsWith("/")
      && url.protocol === "https:" && !url.username && !url.password && !url.port
      && [host, `${host}:443`].includes(rawAuthority.toLowerCase())
      && host.length <= 253 && host !== "localhost.localdomain"
      && !host.endsWith(".localhost") && !host.endsWith(".local") && !host.endsWith(".localhost.localdomain")
      && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(host);
  } catch { return false; }
}

async function connectorOptions(options: HttpAppOptions, env: NodeJS.ProcessEnv): Promise<ConnectorSurfaceOptions> {
  const flag = env.CONNECTOR_ENABLED ?? "false";
  if (flag !== "true" && flag !== "false") throw new Error("Invalid CONNECTOR_ENABLED configuration");
  if (flag === "false") return { enabled: false, trustedPeers: new Set(), redirectUris: new Set() };
  for (const [name, expected] of [["CONNECTOR_ISSUER", CONNECTOR_ISSUER],
    ["CONNECTOR_RESOURCE", CONNECTOR_RESOURCE], ["CONNECTOR_SCOPE", CONNECTOR_SCOPE]]) {
    if (env[name] !== undefined && env[name] !== expected) throw new Error(`Invalid ${name} configuration`);
  }
  const secret = env.CONNECTOR_SERVICE_SECRET ?? "";
  validateServiceSecret(secret);
  const redirects = (env.CONNECTOR_REDIRECT_URIS ?? "https://claude.ai/api/mcp/auth_callback").split(",").map(uri => uri.trim());
  if (redirects.length > 32 || redirects.some(uri => !validRedirect(uri))) throw new Error("Invalid CONNECTOR_REDIRECT_URIS configuration");
  const configured = options.trustedNginxPeerIps ?? (env.CONNECTOR_NGINX_PEER_IPS ?? "").split(",").map(peer => peer.trim());
  const peers = configured.map(peer => normalizeIp(peer));
  if (!peers.length || peers.length > 32 || peers.some(peer => !peer)) throw new Error("Invalid CONNECTOR_NGINX_PEER_IPS configuration");
  const trustedPeers = new Set(peers as string[]);
  const resolver = options.resolveNginxPeers ?? (async () => (await lookup("nginx", { all: true })).map(item => item.address));
  // DNS is checked before listening; deployment must still prove the actual socket chain.
  let observed: readonly string[];
  try { observed = await resolver("nginx"); }
  catch { throw new Error("Connector nginx peer verification unavailable"); }
  const observedPeers = observed.map(peer => normalizeIp(peer));
  const observedSet = new Set(observedPeers);
  if (!observedSet.size || observedPeers.some(peer => !peer) || observedSet.size !== trustedPeers.size
    || [...trustedPeers].some(peer => !observedSet.has(peer))) {
    throw new Error("Connector nginx peer configuration mismatch");
  }
  return { enabled: true, backend: new BackendClient(secret, options.backendFetch),
    trustedPeers, redirectUris: new Set(redirects) };
}

export async function createApp(options: HttpAppOptions = {}): Promise<express.Express> {
  const env = options.env ?? process.env;
  const mcpPath = env.MCP_PATH || "/mcp";
  // A legacy override must never shadow the new credential boundary.
  if ([CONNECTOR_PATH, "/oauth", AUTHORIZATION_METADATA_PATH, RESOURCE_METADATA_PATH]
    .some(path => mcpPath === path || mcpPath.startsWith(`${path}/`))) {
    throw new Error("MCP_PATH conflicts with connector surface");
  }
  const connector = await connectorOptions(options, env);
  const app = express();
  app.set("trust proxy", (address: string) => {
    const normalized = normalizeIp(address);
    return !!normalized && connector.trustedPeers.has(normalized);
  });
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, service: "crawlgraph-mcp", version: VERSION });
  });
  app.use(createOAuthRouter(connector));
  app.all(CONNECTOR_PATH, protectedConnectorHandler(connector, async (req, res, context) => {
    if (req.method !== "POST") { logConnectorHttpError(res, "method_not_allowed", 405); methodNotAllowed(req, res); return; }
    // Parse only after the auth boundary, and never build the public-REST legacy server.
    await new Promise<void>((done, reject) => {
      express.json({ limit: "64kb" })(req, res, error => error ? reject(error) : done());
    });
    const server = await (options.directoryServerFactory ??
      (context => buildDirectoryServer(context, connector.backend!)))(context);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }));

  app.use(express.json({ limit: "1mb" }));
  app.post(mcpPath, async (req, res) => {
    const key = resolveApiKey(req);
    const server = buildServer(() => key);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      console.error("mcp request error: Internal server error");
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });
  app.get(mcpPath, methodNotAllowed);
  app.delete(mcpPath, methodNotAllowed);
  // Express's default error handler can log credential-bearing parser/SDK errors.
  app.use((error: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const path = req.path.toLowerCase();
    if (path.startsWith("/oauth") || path === CONNECTOR_PATH || path.startsWith("/.well-known/oauth-")) {
      if (res.headersSent) { logConnectorHttpError(res, "server_error"); res.end(); return; }
      sendConnectorError(res, error);
      return;
    }
    if (res.headersSent) { res.end(); return; }
    const status = parserErrorStatus(error) ?? 500;
    res.status(status).json({ jsonrpc: "2.0", error: { code: -32603,
      message: status === 500 ? "Internal server error" : "Invalid request body" }, id: null });
  });
  return app;
}

export function logStartupFailure(error: unknown): void {
  try {
    const parsed = connectorStartupReasonSchema.safeParse(error instanceof Error ? error.message : undefined);
    logConnectorTelemetry({ event: "connector_startup", request_id: connectorRequestId(), status: "error",
      code: parsed.success && parsed.data !== "started" ? parsed.data : "startup_failure" });
  } catch { /* Unknown exceptions and logging failures cannot expose configuration. */ }
}

async function main(): Promise<void> {
  const app = await createApp();
  const port = Number(process.env.PORT || 8080);
  app.listen(port, () => {
    logConnectorTelemetry({ event: "connector_startup", request_id: connectorRequestId(), status: "ready", code: "started" });
  }).on("error", error => { logStartupFailure(error); process.exitCode = 1; });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { logStartupFailure(error); process.exitCode = 1; });
}
