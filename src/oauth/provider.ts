import type { Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  OAuthError, AccessDeniedError, InvalidClientError, InvalidClientMetadataError,
  InvalidGrantError, InvalidRequestError, InvalidScopeError, InvalidTargetError,
  InvalidTokenError, InsufficientScopeError, ServerError, TemporarilyUnavailableError,
  TooManyRequestsError, UnauthorizedClientError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import {
  BackendClient, BackendRpcError, CONNECTOR_ISSUER, CONNECTOR_RESOURCE, CONNECTOR_SCOPE,
  publicClientMetadataSchema, type ConnectorGrant, type VerifiedIngress,
} from "../backend-client.js";

export class ConnectorUnavailableError extends TemporarilyUnavailableError {
  readonly retryAfter = 5;
  constructor() { super("Connector temporarily unavailable"); }
}

export class ConnectorThrottleError extends TooManyRequestsError {
  constructor(readonly retryAfter: number) { super("Connector rate limit exceeded"); }
}

export function toOAuthError(error: unknown): OAuthError {
  if (error instanceof OAuthError) return error;
  if (!(error instanceof BackendRpcError)) return new ConnectorUnavailableError();
  switch (error.code) {
    case "temporarily_unavailable": return new ConnectorUnavailableError();
    case "rate_limited": return new ConnectorThrottleError(error.retryAfter ?? 5);
    case "invalid_client": return new InvalidClientError("Invalid client");
    case "invalid_client_metadata": return new InvalidClientMetadataError("Invalid client metadata");
    case "invalid_redirect_uri": return new InvalidRequestError("Invalid redirect URI");
    case "invalid_grant": return new InvalidGrantError("Invalid grant");
    case "invalid_scope": return new InvalidScopeError("Unsupported scope");
    case "invalid_target": return new InvalidTargetError("Exact connector resource required");
    case "invalid_token": return new InvalidTokenError("Invalid access token");
    case "insufficient_scope": return new InsufficientScopeError("Required scope missing");
    case "unauthorized_client": return new UnauthorizedClientError("Unauthorized client");
    case "access_denied": return new AccessDeniedError("Access denied");
    case "invalid_request": return new InvalidRequestError("Invalid OAuth request");
  }
}

export interface ProviderContext {
  ingress: VerifiedIngress;
  signal: AbortSignal;
  input: Readonly<Record<string, unknown>>;
  browserNonce: () => string;
  client?: OAuthClientInformationFull;
  failure?: OAuthError;
}

export interface ConnectorAuthInfo extends AuthInfo {
  expiresAt: number;
  resource: URL;
  grant: ConnectorGrant;
}

function requireScopes(scopes: string[] | undefined): void {
  if (!scopes || scopes.length !== 1 || scopes[0] !== CONNECTOR_SCOPE) {
    throw new InvalidScopeError("Unsupported scope");
  }
}

// SDK URL construction normalizes ports/dot segments; the raw request must also match.
function requireResource(resource: URL | undefined, raw: unknown): void {
  if (raw !== CONNECTOR_RESOURCE || resource?.href !== CONNECTOR_RESOURCE) {
    throw new InvalidTargetError("Exact connector resource required");
  }
}

export class ConnectorProvider implements OAuthServerProvider {
  readonly skipLocalPkceValidation = true;
  readonly clientsStore: OAuthRegisteredClientsStore;

  constructor(private readonly backend: BackendClient, private readonly redirects: ReadonlySet<string>,
    readonly context: ProviderContext) {
    this.clientsStore = {
      getClient: clientId => this.capture(async () => {
        const client = await backend.getClient(clientId, context.ingress, context.signal);
        if (client && client.redirect_uris.some(uri => !redirects.has(uri))) throw new ConnectorUnavailableError();
        context.client = client;
        return client;
      }),
      registerClient: info => this.capture(async () => {
        // SDK omission generates a secret and UUID. Backend owns IDs and public metadata.
        const { client_secret: _secret, client_secret_expires_at: _expiry,
          client_id: _id, client_id_issued_at: _issued, ...metadata } = info as OAuthClientInformationFull;
        if (metadata.token_endpoint_auth_method !== undefined && metadata.token_endpoint_auth_method !== "none") {
          throw new InvalidClientMetadataError("Public clients required");
        }
        const parsed = publicClientMetadataSchema.safeParse({ ...metadata,
          token_endpoint_auth_method: "none", ...(metadata.scope === "" ? { scope: CONNECTOR_SCOPE } : {}) });
        // The SDK normalizes URLs; require unchanged, unique raw callback strings.
        const rawRedirects = context.input.redirect_uris;
        if (!parsed.success || !Array.isArray(rawRedirects)
          || rawRedirects.length !== parsed.data.redirect_uris.length
          || new Set(rawRedirects).size !== rawRedirects.length
          || parsed.data.redirect_uris.some((uri, index) => !redirects.has(uri) || rawRedirects[index] !== uri)) {
          throw new InvalidClientMetadataError("Invalid public client metadata");
        }
        const client = await backend.registerClient(parsed.data, context.ingress, context.signal);
        if (client.redirect_uris.some(uri => !redirects.has(uri))) throw new ConnectorUnavailableError();
        return client;
      }),
    };
  }

  private async capture<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      const mapped = toOAuthError(error);
      this.context.failure = mapped;
      throw mapped;
    }
  }

  authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    return this.capture(async () => {
      requireResource(params.resource, this.context.input.resource);
      const scopes = this.context.input.scope === undefined ? [CONNECTOR_SCOPE] : params.scopes;
      requireScopes(scopes);
      if (!this.redirects.has(params.redirectUri) || !client.redirect_uris.includes(params.redirectUri)) {
        throw new InvalidRequestError("Invalid redirect URI");
      }
      const start = await this.backend.beginAuthorization({
        client_id: client.client_id, redirect_uri: params.redirectUri, resource: CONNECTOR_RESOURCE,
        scopes: scopes!, code_challenge: params.codeChallenge, code_challenge_method: "S256",
        browser_nonce: this.context.browserNonce(), state: params.state,
      }, this.context.ingress, this.context.signal);
      const expectedPath = `/connectors/authorize?transaction_id=${start.transaction_id}`;
      if (start.frontend_path !== expectedPath) throw new ConnectorUnavailableError();
      res.redirect(302, `${CONNECTOR_ISSUER}${expectedPath}`);
    });
  }

  async challengeForAuthorizationCode(): Promise<string> {
    throw new ServerError("Local PKCE validation unavailable");
  }

  exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, verifier?: string,
    redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    return this.capture(async () => {
      requireResource(resource, this.context.input.resource);
      if (verifier === undefined) throw new InvalidRequestError("PKCE verifier required");
      return this.backend.exchangeCode({ client_id: client.client_id, code, verifier,
        redirect_uri: redirectUri, resource: CONNECTOR_RESOURCE }, this.context.ingress, this.context.signal);
    });
  }

  exchangeRefreshToken(client: OAuthClientInformationFull, token: string,
    scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    return this.capture(async () => {
      if (scopes !== undefined) requireScopes(scopes);
      if (resource !== undefined) requireResource(resource, this.context.input.resource);
      return this.backend.exchangeRefresh({ client_id: client.client_id, refresh_token: token,
        scopes, resource: resource?.href }, this.context.ingress, this.context.signal);
    });
  }

  verifyAccessToken(token: string): Promise<ConnectorAuthInfo> {
    return this.capture(async () => {
      const grant = await this.backend.introspect(token, this.context.ingress, this.context.signal);
      const now = Math.floor(Date.now() / 1000);
      if (grant.resource !== CONNECTOR_RESOURCE || grant.expires_at <= now || grant.grant_expires_at <= now) {
        throw new InvalidTokenError("Invalid access token");
      }
      if (grant.scopes.length !== 1 || grant.scopes[0] !== CONNECTOR_SCOPE) {
        throw new InsufficientScopeError("Required scope missing");
      }
      return { token, clientId: grant.client_id, scopes: grant.scopes, expiresAt: grant.expires_at,
        resource: new URL(CONNECTOR_RESOURCE), grant };
    });
  }

  revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    return this.capture(() => {
      if (request.token.length > 256) throw new InvalidRequestError("Invalid revocation request");
      return this.backend.revoke(client.client_id, request.token, this.context.ingress, this.context.signal);
    });
  }
}
