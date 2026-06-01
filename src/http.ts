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

import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer, VERSION } from "./server.js";

const PORT = Number(process.env.PORT || 8080);
// nginx terminates TLS and strips the /mcp prefix by default; allow overriding
// the route the app serves on if the proxy passes the prefix through.
const MCP_PATH = process.env.MCP_PATH || "/mcp";

const app = express();
app.use(express.json({ limit: "1mb" }));

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

// Liveness probe (used by Docker healthcheck / nginx). No auth, no MCP.
app.get("/healthz", (_req, res) => {
  res.json({ ok: true, service: "crawlgraph-mcp", version: VERSION });
});

// MCP endpoint. Stateless: one server+transport per request, keyed by the
// caller's Bearer token.
app.post(MCP_PATH, async (req, res) => {
  const key = resolveApiKey(req);
  const server = buildServer(() => key);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    // Respond with application/json rather than an SSE stream. Our tools
    // return complete results (no partial streaming), and JSON responses
    // pass cleanly through Cloudflare + nginx without SSE buffering issues.
    enableJsonResponse: true,
  });
  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("mcp request error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Stateless mode doesn't use the GET (server->client SSE stream) or DELETE
// (session teardown) verbs — answer them per the MCP spec with 405.
const methodNotAllowed = (_req: express.Request, res: express.Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed. This server is stateless; use POST." },
    id: null,
  });
};
app.get(MCP_PATH, methodNotAllowed);
app.delete(MCP_PATH, methodNotAllowed);

app.listen(PORT, () => {
  console.error(`crawlgraph-mcp HTTP server v${VERSION} on :${PORT} (MCP at ${MCP_PATH})`);
});
