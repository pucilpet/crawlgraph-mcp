# Hosted MCP operation

Hosted deployment is operator-owned across crawlback and this standalone MCP
service. Follow both authoritative crawlback runbooks **in full**:

- [Connector release runbook](https://github.com/pucilpet/crawlback/blob/master/docs/ops/connector-release-runbook.md)
- [Hosted MCP lifecycle and smoke runbook](https://github.com/pucilpet/crawlback/blob/master/docs/ops/hosted-mcp-smoke.md)

These documents own the deployment sequence, externally managed container
record, ingress verification, credentials, review gates, release receipts and
rollback. This file describes the source configuration contract; it is not a
replacement deployment procedure. No ad hoc nginx/container recreation
shortcut is prescribed here. The standalone MCP service remains externally
managed; do not adopt it into crawlback Compose as part of this change.

## Authentication surfaces

| Surface | Authentication |
| --- | --- |
| npm / stdio and legacy `/mcp` | Caller API key; legacy Smithery query/config forms remain supported |
| `/mcp/connectors` | Header-only OAuth access token for the exact connector resource |
| OAuth discovery and `/oauth/*` | SDK protocol handlers backed by private domain RPCs |
| Docker-private `/internal/mcp/*` | Dedicated service credential; execution also requires the grant bearer token |

The private backend destination is hard-fixed in
[src/backend-client.ts](src/backend-client.ts) to
`http://backend:8000/internal/mcp`. Tool arguments and legacy
`CRAWLGRAPH_BASE_URL` cannot select it. OAuth credentials never authorize
public `/api/v1` requests. Public ingress must deny `/internal/` ahead of
other API routing, as specified in the runbooks.

## Operator configuration contract

Keep credential values and the external service lifecycle record private.
Record these actual source setting names before release:

| Setting | Source requirement |
| --- | --- |
| `CONNECTOR_ENABLED` | Exactly `true` or `false`; defaults to `false` |
| `CONNECTOR_SERVICE_SECRET` | Dedicated private service credential, matching the backend; validated printable non-whitespace ASCII, 32–512 characters |
| `CONNECTOR_ISSUER` | If set, exactly `https://crawlgraph.com` |
| `CONNECTOR_RESOURCE` | If set, exactly `https://crawlgraph.com/mcp/connectors` |
| `CONNECTOR_SCOPE` | If set, exactly `crawlgraph:read` |
| `CONNECTOR_REDIRECT_URIS` | Comma-separated exact approved hosted HTTPS callback URLs; no wildcards, query/fragment, loopback or credentials |
| `CONNECTOR_NGINX_PEER_IPS` | Recorded exact peer IPs, comma-separated; no subnet-wide trust or hop-count assumptions |
| `PORT` | HTTP listen port, default `8080` |
| `MCP_PATH` | Legacy route, default `/mcp`; must not shadow connector/OAuth/discovery routes |

The default callback in source is
`https://claude.ai/api/mcp/auth_callback`; it does not prove real-client
compatibility. Provision the approved callback inventory through the runbook.
Copy OpenAI's callback from the actual portal and record its evidence. Node
normalizes omitted DCR auth method to public `none`, discards SDK-generated
secrets, rejects confidential methods and never fetches client metadata
URLs. The issuer/resource/scope are fixed, not deployment aliases.

Provision and rotate a dedicated connector service secret; do not reuse a
broad backend/admin credential or place a service secret in client configs,
listing packages, logs or release receipts. Reviewer credentials, grants,
review-window dates and the chosen exact client-ID/callback policy have an
assigned operator owner. Provisioning, rotation, closure and revocation use
the backend runbook. Reviewer access is a restricted OAuth demo session,
not a normal account/admin/key-management session; backend review policy must
be active and independently verified before submission.

## Ingress and release verification

Before enabling, record the actual socket peer seen by Node, including any
tunnel or forwarder in the chain. Source startup resolves the fixed Docker
name `nginx` and requires the normalized DNS address set to match the recorded
peer set exactly. Resolution failure or mismatch prevents startup. This DNS
check alone does not prove the live forwarding boundary. Container/proxy
changes require a fresh peer record and the runbook's live smoke evidence.

Sensitive routes require a trusted socket peer plus exactly one sanitized
`X-Forwarded-For` IP. Duplicate headers and comma-separated chains fail closed
with 503. The authoritative nginx configuration must use verified ingress
trust and **overwrite** `X-Forwarded-For` and `X-Real-IP` with the verified
source address. Appending a caller's forwarding chain is invalid for these
routes. Never assume direct Cloudflare ingress; follow the recorded real
chain and current trusted CIDRs in crawlback's runbooks. Do not expose
programmatic fake-fetch, clock or peer-resolution test seams as production
environment bypasses.

Node's router admission uses a canonical IPv6 /64 key, expanded before grouping;
IPv4-mapped addresses share their normalized IPv4 bucket. The key affects only
local admission. Full normalized verified source addresses still reach private
RPCs. Registration remains 200/hour, authorization 100/15 minutes, and token
and revoke share a 1,000/minute source ceiling. Each policy map holds at most
4,096 live windows, uses monotonic expiry and rejects new buckets at capacity
without eviction. Backend client/family/user admission policies remain separate.

Node emits fixed-field JSON telemetry on stderr, preserving stdout for stdio
MCP. Tool lines use internal correlation IDs and fixed names, final envelope
status and `isError`, allowlisted codes, latency, exact final UTF-8 result bytes,
known charge counts and bounded unknown-consumption/partial-code arrays.
HTTP/OAuth failure lines use response-local IDs, fixed route categories,
status and allowlisted error codes, with duplicate suppression. Startup failure
reasons match an exact fixed-message allowlist; unknown exceptions use the
generic `startup_failure` category. No raw exceptions, URLs, redirect state,
arguments, results, domains, identifying account/job/grant/client/source fields,
caller request IDs, headers, configuration or credentials enter these lines.
Telemetry failure cannot throw into the response path. Startup still fails
closed on invalid configuration or nginx DNS/peer verification failure.

Deploy additive backend schema with connector access disabled first, then the
compatible standalone MCP service with OAuth disabled, then the reviewed
proxy/configuration under the complete cross-repository release process.
Enable only after independent code review, both repositories' checks,
legacy regression smoke, real metadata/challenge/private-route checks and
required Claude/OpenAI protocol cases pass. Account consent, owner-bound job
resume and shared quotas need real backend evidence; fake Node RPCs cannot
prove SQLite transactions or query pinning.

Disabled connector routes, including discovery, return 503 with
`Retry-After: 5` and no relink challenge; legacy `/mcp` remains available.
OAuth/introspection outages return 503; execution outages return safe tool
errors inside HTTP 200 MCP responses, without relink metadata. Missing
or invalid OAuth access yields a resource discovery challenge; revocation
between introspection and execution yields tool `mcp/www_authenticate`
metadata. Sensitive logs must omit bearer tokens, codes, refresh credentials,
cookies, reviewer secrets, packed configs and OAuth query strings.

Source version **0.4.0**, npm publication version and hosted image/version are
separate facts. Record the reviewed commit, dependency/build evidence and
actual hosted `initialize`/`tools/list` receipts separately. Local tests do
not establish live deployment, directory approval, Verified status or real
platform compatibility. npm publication is a separate operator action.

## Rollback and continuing ownership

Use the runbooks' approved rollback: disable new authorization/tool access,
close reviewer access and revoke affected grants/families, restore the
compatible MCP/proxy release, and preserve additive authorization schema,
revocation/audit state and research jobs. Do not drop the new tables. If the
issuer has been externally used, retain its disabled-service/auth tombstone
behavior; an older app must not silently ignore grants or reopen review
login. Keep a named owner for service-secret rotation, reviewer lifecycle,
peer refresh, failed protocol gates and post-release monitoring.

## Local gate and health contract

```bash
npm run build
node --test tests/*.test.mjs
```

No separate lint command is configured. HTTP fixtures need loopback listener
permission and no production key. Failed tests block release; keep their
assertions and report source or environment failures without skipping them.

Container-internal `/healthz` reports liveness and source version, not OAuth
readiness. Legacy `GET /mcp` and `DELETE /mcp` return 405. A valid authenticated
connector GET/DELETE also returns 405; unauthenticated, disabled or untrusted
requests first cross the connector auth/availability boundary.

Source references: [startup/configuration and HTTP routes](src/http.ts),
[ingress/private transport](src/backend-client.ts),
[OAuth metadata/errors](src/oauth/router.ts),
[grant/provider translation](src/oauth/provider.ts), and
[bounded tools/accounting](src/tool-profile.ts).
