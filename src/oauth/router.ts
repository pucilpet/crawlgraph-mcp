import { randomBytes } from "node:crypto";
import express, { type Request, type Response, type RequestHandler } from "express";
import { authorizationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import { tokenHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/token.js";
import { clientRegistrationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/register.js";
import { revocationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/revoke.js";
import { mcpAuthMetadataRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { OAuthMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  OAuthError, InvalidRequestError, InvalidTokenError, InsufficientScopeError,
  TemporarilyUnavailableError, TooManyRequestsError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import {
  BackendClient, CONNECTOR_ISSUER, CONNECTOR_RESOURCE, CONNECTOR_SCOPE,
  verifiedIngress, normalizeIp, connectorRequestId, logConnectorTelemetry,
  connectorTelemetryCodeSchema, type ConnectorTelemetry, type VerifiedIngress,
} from "../backend-client.js";
import {
  ConnectorProvider, ConnectorUnavailableError, ConnectorThrottleError,
  toOAuthError, type ProviderContext, type ConnectorAuthInfo,
} from "./provider.js";

export const CONNECTOR_PATH = "/mcp/connectors";
export const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource/mcp/connectors";
export const AUTHORIZATION_METADATA_PATH = "/.well-known/oauth-authorization-server";
export const CONNECTOR_METADATA: OAuthMetadata = {
  issuer: CONNECTOR_ISSUER,
  authorization_endpoint: `${CONNECTOR_ISSUER}/oauth/authorize`,
  token_endpoint: `${CONNECTOR_ISSUER}/oauth/token`,
  registration_endpoint: `${CONNECTOR_ISSUER}/oauth/register`,
  revocation_endpoint: `${CONNECTOR_ISSUER}/oauth/revoke`,
  revocation_endpoint_auth_methods_supported: ["none"],
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
  scopes_supported: [CONNECTOR_SCOPE],
  client_id_metadata_document_supported: false,
};

export interface ConnectorSurfaceOptions {
  enabled: boolean;
  backend?: BackendClient;
  trustedPeers: ReadonlySet<string>;
  redirectUris: ReadonlySet<string>;
}

const MAX_SOURCE_BUCKETS = 4096;

function sourceBucketKey(source: string): string {
  const normalized = normalizeIp(source);
  if (!normalized) throw new ConnectorUnavailableError();
  if (!normalized.includes(":")) return normalized;
  const halves = normalized.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const hextets = halves.length === 2
    ? [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right] : left;
  // Expand compression before grouping. This key never replaces the RPC source.
  return hextets.slice(0, 4).map(part => part.padStart(4, "0")).join(":");
}

function sourceAdmission(limit: number, windowMs: number): (ingress: VerifiedIngress) => void {
  const buckets = new Map<string, { count: number; expiresAt: number }>();
  return ingress => {
    const now = performance.now();
    // Fixed windows and a monotonic clock keep insertion order equal to expiry order.
    for (const [source, bucket] of buckets) {
      if (bucket.expiresAt > now) break;
      buckets.delete(source);
    }
    const retryAfter = (expiresAt: number) => Math.max(1, Math.ceil((expiresAt - now) / 1000));
    const key = sourceBucketKey(ingress.source);
    let bucket = buckets.get(key);
    if (!bucket) {
      if (buckets.size >= MAX_SOURCE_BUCKETS) {
        // Fail closed until the first retained window expires; never evict a live source.
        throw new ConnectorThrottleError(retryAfter(buckets.values().next().value!.expiresAt));
      }
      bucket = { count: 0, expiresAt: now + windowMs };
      buckets.set(key, bucket);
    }
    if (bucket.count >= limit) throw new ConnectorThrottleError(retryAfter(bucket.expiresAt));
    // Admission completes synchronously before any parser or backend await.
    bucket.count++;
  };
}

export const privateHeaders: RequestHandler = (_req, res, next) => {
  res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  next();
};

type HttpTelemetry = Extract<ConnectorTelemetry, { event: "connector_http" }>;
const httpTelemetry = new WeakMap<Response, { requestId: string; category: HttpTelemetry["category"]; logged: boolean }>();
function beginHttpTelemetry(req: Request, res: Response): void {
  if (httpTelemetry.has(res)) return;
  // Classify locally; raw paths, query strings and caller IDs never enter logs.
  const path = req.originalUrl.split("?")[0].toLowerCase();
  const categories: Record<string, HttpTelemetry["category"]> = {
    [CONNECTOR_PATH]: "connector", "/oauth/authorize": "oauth_authorize", "/oauth/token": "oauth_token",
    "/oauth/register": "oauth_register", "/oauth/revoke": "oauth_revoke",
    [AUTHORIZATION_METADATA_PATH]: "authorization_metadata", [RESOURCE_METADATA_PATH]: "resource_metadata",
  };
  const category = categories[path] ?? (path === "/oauth" || path.startsWith("/oauth/") ? "oauth_other" : "unknown");
  httpTelemetry.set(res, { requestId: connectorRequestId(), category, logged: false });
}
export function logConnectorHttpError(res: Response, code: unknown, status = res.statusCode): void {
  try {
    const state = httpTelemetry.get(res) ?? { requestId: connectorRequestId(), category: "unknown" as const, logged: false };
    if (state.logged) return;
    state.logged = true;
    httpTelemetry.set(res, state);
    const parsed = connectorTelemetryCodeSchema.safeParse(code);
    logConnectorTelemetry({ event: "connector_http", request_id: state.requestId, category: state.category,
      status, code: parsed.success ? parsed.data : "server_error" });
  } catch { /* A failed logger must not affect the response. */ }
}

const safeCodes = new Set([
  "invalid_request", "invalid_client", "invalid_client_metadata", "invalid_grant", "invalid_scope",
  "invalid_target", "invalid_token", "insufficient_scope", "unauthorized_client", "access_denied",
  "unsupported_grant_type", "unsupported_response_type", "unsupported_token_type", "server_error",
  "temporarily_unavailable", "too_many_requests", "method_not_allowed",
]);

function safeErrorBody(code: unknown): { error: string; error_description: string } {
  const error = typeof code === "string" && safeCodes.has(code) ? code : "server_error";
  return { error, error_description: error === "temporarily_unavailable" ? "Connector temporarily unavailable"
    : error === "too_many_requests" ? "Connector rate limit exceeded" : "OAuth request failed" };
}

function availabilityStatus(error: OAuthError | undefined, res: Response): boolean {
  if (error instanceof TemporarilyUnavailableError) {
    res.status(503).set("Retry-After", "5").removeHeader("WWW-Authenticate");
    return true;
  }
  if (error instanceof TooManyRequestsError) {
    res.status(429).set("Retry-After", String(error instanceof ConnectorThrottleError ? error.retryAfter : 5))
      .removeHeader("WWW-Authenticate");
    res.removeHeader("Location");
    return true;
  }
  return false;
}

export function sendUnavailable(res: Response, category?: "disabled" | "untrusted_peer"): void {
  if (category) logConnectorHttpError(res, category, 503);
  sendConnectorError(res, new ConnectorUnavailableError());
}

// The same typed challenge can later be used in tool `_meta` after live grant rechecks.
export function connectorChallenge(error?: InvalidTokenError | InsufficientScopeError): string {
  const details = error ? `, error="${error instanceof InsufficientScopeError ? "insufficient_scope" : "invalid_token"}"` : "";
  return `Bearer resource_metadata="${CONNECTOR_ISSUER}${RESOURCE_METADATA_PATH}", scope="${CONNECTOR_SCOPE}"${details}`;
}

export function sendConnectorError(res: Response, error: unknown): void {
  res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  const status = parserErrorStatus(error);
  if (status !== undefined) {
    res.removeHeader("Retry-After");
    res.removeHeader("WWW-Authenticate");
    logConnectorHttpError(res, "invalid_request", status);
    res.status(status).json(safeErrorBody("invalid_request"));
    return;
  }
  const mapped = toOAuthError(error);
  if (!availabilityStatus(mapped, res)) {
    if (mapped instanceof InsufficientScopeError) {
      res.status(403).set("WWW-Authenticate", connectorChallenge(mapped));
    } else if (mapped instanceof InvalidTokenError) {
      res.status(401).set("WWW-Authenticate", connectorChallenge(mapped));
    } else {
      res.status(mapped instanceof InvalidRequestError ? 400 : 500).removeHeader("WWW-Authenticate");
    }
  }
  const body = safeErrorBody(mapped.errorCode);
  logConnectorHttpError(res, body.error);
  res.json(body);
}

export function parserErrorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  return error.status === 400 || error.status === 413 || error.status === 415 ? error.status : undefined;
}

export function requestSignal(req: Request, res: Response): AbortSignal {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const cleanup = () => {
    abort();
    req.removeListener("aborted", abort);
    res.removeListener("close", cleanup);
    res.removeListener("finish", cleanup);
  };
  req.once("aborted", abort);
  res.once("close", cleanup);
  res.once("finish", cleanup);
  return controller.signal;
}

function browserNonce(req: Request, res: Response): string {
  const matches = (req.headers.cookie ?? "").split(";").map(part => part.trim())
    .filter(part => part.startsWith("cg_connector_nonce="));
  const existing = matches.length === 1 ? matches[0].slice("cg_connector_nonce=".length) : "";
  const nonce = /^[A-Za-z0-9_-]{43}$/.test(existing) ? existing : randomBytes(32).toString("base64url");
  res.cookie("cg_connector_nonce", nonce, { httpOnly: true, secure: true, sameSite: "lax", path: "/" });
  return nonce;
}

function inputFor(req: Request): Readonly<Record<string, unknown>> {
  return (req.method === "POST" ? req.body : req.query) ?? {};
}

function installSdkCorrections(res: Response, context: ProviderContext, redirects: ReadonlySet<string>): void {
  const json = res.json.bind(res);
  res.json = body => {
    // SDK flattens even typed errors from client lookup to400.
    availabilityStatus(context.failure, res);
    if (body && typeof body === "object" && "error" in body) {
      body = safeErrorBody(context.failure?.errorCode ?? body.error);
      logConnectorHttpError(res, body.error);
    }
    return json(body);
  };
  const redirect = res.redirect.bind(res);
  res.redirect = ((statusOrUrl: number | string, location?: string) => {
    const status = typeof statusOrUrl === "number" ? statusOrUrl : 302;
    const url = new URL(typeof statusOrUrl === "string" ? statusOrUrl : location!);
    if (!url.searchParams.has("error")) return redirect(status, url.href);
    if (availabilityStatus(context.failure, res)) {
      const body = safeErrorBody(context.failure?.errorCode);
      logConnectorHttpError(res, body.error);
      json(body);
      return;
    }
    const client = context.client;
    // SDK has validated the registered callback; this adds the global exact allowlist.
    const requested = context.input.redirect_uri;
    const selected = requested === undefined && client?.redirect_uris.length === 1 ? client.redirect_uris[0] : requested;
    if (typeof selected !== "string" || !redirects.has(selected) || !client?.redirect_uris.includes(selected)) {
      res.status(400).json(safeErrorBody("invalid_request"));
      return;
    }
    const callback = new URL(selected);
    if (url.origin !== callback.origin || url.pathname !== callback.pathname) {
      res.status(400).json(safeErrorBody("invalid_request"));
      return;
    }
    const body = safeErrorBody(context.failure?.errorCode ?? url.searchParams.get("error"));
    // Rebuild only protocol error fields. SDK/Zod descriptions can include caller values.
    const corrected = new URL(selected);
    corrected.searchParams.set("error", body.error);
    corrected.searchParams.set("error_description", body.error_description);
    if (typeof context.input.state === "string") corrected.searchParams.set("state", context.input.state);
    logConnectorHttpError(res, body.error, status);
    return redirect(status, corrected.href);
  }) as Response["redirect"];
}

export function createOAuthRouter(options: ConnectorSurfaceOptions): express.Router {
  const router = express.Router();
  const paths = ["/oauth", AUTHORIZATION_METADATA_PATH, RESOURCE_METADATA_PATH];
  router.use(paths, privateHeaders, (req, res, next) => {
    beginHttpTelemetry(req, res);
    if (!options.enabled || !options.backend) {
      sendUnavailable(res, "disabled");
      return;
    }
    next();
  });
  if (!options.enabled || !options.backend) return router;
  router.use("/oauth", (req, res, next) => {
    if (!verifiedIngress(req, options.trustedPeers)) { sendUnavailable(res, "untrusted_peer"); return; }
    next();
  });
  router.use(mcpAuthMetadataRouter({ oauthMetadata: CONNECTOR_METADATA,
    resourceServerUrl: new URL(CONNECTOR_RESOURCE), scopesSupported: [CONNECTOR_SCOPE] }));
  const tokenAdmission = sourceAdmission(1000, 60_000);
  const admission = {
    register: sourceAdmission(200, 3_600_000),
    authorize: sourceAdmission(100, 900_000),
    token: tokenAdmission,
    revoke: tokenAdmission,
  };
  for (const endpoint of ["authorize", "token", "register", "revoke"] as const) {
    router.use(`/oauth/${endpoint}`,
      (req, res, next) => {
        const ingress = verifiedIngress(req, options.trustedPeers);
        if (!ingress) { sendUnavailable(res, "untrusted_peer"); return; }
        try { admission[endpoint](ingress); }
        catch (error) { sendConnectorError(res, error); return; }
        next();
      },
      express.json({ limit: "16kb" }),
      express.urlencoded({ extended: false, limit: "16kb", parameterLimit: 64 }),
      (req, res, next) => {
        const ingress = verifiedIngress(req, options.trustedPeers);
        if (!ingress) { sendUnavailable(res, "untrusted_peer"); return; }
        const context: ProviderContext = { ingress, signal: requestSignal(req, res), input: inputFor(req),
          browserNonce: () => browserNonce(req, res) };
        const provider = new ConnectorProvider(options.backend!, options.redirectUris, context);
        installSdkCorrections(res, context, options.redirectUris);
        // Source admission lives on this router; SDK factories retain isolated request providers.
        const handler = endpoint === "authorize" ? authorizationHandler({ provider, rateLimit: false })
          : endpoint === "token" ? tokenHandler({ provider, rateLimit: false })
          : endpoint === "revoke" ? revocationHandler({ provider, rateLimit: false })
          : clientRegistrationHandler({ clientsStore: provider.clientsStore, rateLimit: false });
        handler(req, res, next);
      });
  }
  return router;
}

export interface ProtectedConnectorContext {
  auth: ConnectorAuthInfo;
  ingress: VerifiedIngress;
  signal: AbortSignal;
}

function bearerToken(req: Request): string | undefined {
  const queryStart = req.originalUrl.indexOf("?");
  const query = new URLSearchParams(queryStart < 0 ? "" : req.originalUrl.slice(queryStart + 1));
  for (const name of query.keys()) {
    const root = name.toLowerCase().split(/[\[.]/)[0];
    if (["access_token", "apikey", "config"].includes(root)) throw new InvalidTokenError("Query credentials forbidden");
  }
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === "authorization") count++;
  }
  if (count === 0) return undefined;
  const header = req.headers.authorization;
  if (count !== 1 || typeof header !== "string") throw new InvalidTokenError("Ambiguous authorization");
  const match = /^Bearer ([A-Za-z0-9._~-]{1,256})$/i.exec(header);
  if (!match || match[1].startsWith("cg_live")) throw new InvalidTokenError("Invalid access token");
  return match[1];
}

export function protectedConnectorHandler(options: ConnectorSurfaceOptions,
  handle: (req: Request, res: Response, context: ProtectedConnectorContext) => Promise<void>): RequestHandler {
  return async (req, res) => {
    beginHttpTelemetry(req, res);
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    if (!options.enabled || !options.backend) { sendUnavailable(res, "disabled"); return; }
    const ingress = verifiedIngress(req, options.trustedPeers);
    if (!ingress) { sendUnavailable(res, "untrusted_peer"); return; }
    try {
      const token = bearerToken(req);
      if (token === undefined) {
        logConnectorHttpError(res, "missing_bearer", 401);
        res.status(401).set("WWW-Authenticate", connectorChallenge()).json(safeErrorBody("invalid_token"));
        return;
      }
      const signal = requestSignal(req, res);
      const provider = new ConnectorProvider(options.backend, options.redirectUris, {
        ingress, signal, input: {}, browserNonce: () => { throw new InvalidRequestError("Browser authorization required"); },
      });
      const auth = await provider.verifyAccessToken(token);
      (req as Request & { auth: ConnectorAuthInfo }).auth = auth;
      await handle(req, res, { auth, ingress, signal });
    } catch (error) {
      if (!res.headersSent) sendConnectorError(res, error);
      else {
        const code = parserErrorStatus(error) !== undefined ? "invalid_request" : toOAuthError(error).errorCode;
        logConnectorHttpError(res, code);
      }
    }
  };
}
