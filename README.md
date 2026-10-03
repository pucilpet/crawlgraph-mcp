# crawlgraph-mcp

Five MCP tools for backlink research using [CrawlGraph](https://crawlgraph.com)
and Common Crawl snapshots: `backlinks`, `backlink_changes`, `gap_analysis`,
`gap_outreach_targets`, and `releases`. Outreach tools identify research
candidates; they do not send messages or create contacts.

## Choose an authentication profile

| Surface | Credentials | Tool profile |
| --- | --- | --- |
| npm / local stdio | Your `CRAWLGRAPH_API_KEY` (`cg_live_…`) | Legacy |
| `https://crawlgraph.com/mcp` | Your API key in `Authorization: Bearer cg_live_…` | Legacy |
| `https://crawlgraph.com/mcp/connectors` | Account-linked OAuth access token in the Authorization header | Bounded directory profile, when enabled |

Legacy `/mcp` also accepts Smithery's `?apiKey=…` and base64 JSON `?config=…`
forms. Header credentials take precedence, then `apiKey`, then packed `config`.
Prefer the Authorization header. The connector endpoint rejects API keys,
query credentials and packed configuration; OAuth tokens never go to the
public `/api/v1` API.

Directory approval and real Claude/OpenAI compatibility verification remain
pending. No Verified listing or logo is claimed. This checkout's source
version is **0.4.0**; it does not establish the current npm or hosted version.
Verify each distribution separately through the operator runbooks linked in
[DEPLOY.md](DEPLOY.md).

## API-key setup: npm / stdio and legacy HTTP

Obtain a key through [CrawlGraph's API onboarding](https://crawlgraph.com/docs/api).
The free-key flow emails a key; it does not sign you into an account.

For Claude Desktop / Claude Code, put this in your client's MCP configuration:

```json
{
  "mcpServers": {
    "crawlgraph": {
      "command": "npx",
      "args": ["-y", "crawlgraph-mcp"],
      "env": {
        "CRAWLGRAPH_API_KEY": "cg_live_your_key_here"
      }
    }
  }
}
```

Cursor, Windsurf, Cline and Zed use the same command/environment arrangement.
Streamable HTTP clients can use `https://crawlgraph.com/mcp` with their own
bearer API key. Confirm the hosted `tools/list` response before relying on a
specific source feature.

| Local stdio setting | Required | Default |
| --- | --- | --- |
| `CRAWLGRAPH_API_KEY` | Yes for tool execution; resolved lazily | — |
| `CRAWLGRAPH_BASE_URL` | No; legacy REST adapter only | `https://crawlgraph.com` |

## Account linking: OAuth connector

When the operator enables the reviewed service, connect to
`https://crawlgraph.com/mcp/connectors` using an existing CrawlGraph account,
sign in and approve consent in the original connection browser. Account
creation is outside OAuth. If you need an account, follow the disclosed
onboarding flow, then return and request sign-in; an emailed API key alone is
not a login session.

The issuer is `https://crawlgraph.com`, the exact resource is
`https://crawlgraph.com/mcp/connectors`, and the only scope is
`crawlgraph:read`. Public clients use authorization code plus S256 PKCE and
`token_endpoint_auth_method=none`. Omitted registration auth method is
normalized to `none` and any SDK-generated secret is discarded. Confidential
client methods and metadata-document fetching are unsupported. Callbacks
must be exact operator-approved HTTPS URLs. OpenAI's callback must come from
the actual portal; this repository does not supply a guessed callback.

Authorization and code exchange require the exact raw resource value. At code
exchange a supplied `redirect_uri` must exactly match the stored callback;
omission retains that callback. Refresh may omit resource and scope to retain
the original grant. PKCE is validated by the backend during the atomic code
exchange, alongside client/resource/redirect/scope checks.

Use account connection management to disconnect and revoke the entire grant
and refresh family. An expired access token can be refreshed while its grant
and refresh family remain valid; revoked or expired grants require
reconnecting. Discovery, OAuth and introspection outages return 503 without
a relink challenge. Execution outages return a safe tool error inside the
HTTP 200 MCP result, without relink metadata. Tool-time revocation is reported
through `mcp/www_authenticate` result metadata. Refresh rotation
has no retry grace: concurrent reuse revokes the family, and a lost token
response may require reconnecting. A 503 after a possible commit does not
promise an unused code or refresh token.

## Quotas and directory tools

Both auth profiles share the account's UTC calendar-month counters. Free
accounts have **15 backlinks calls and 0 gap jobs**; accounts with current paid
access have **1,000 backlinks calls and 50 gap jobs**. Paid eligibility follows
the backend's current entitlement rules. Release inventory consumes no
research quota. `backlink_changes` shares the backlinks counter.

Directory inputs and costs:

| Tool | Arguments | Cost |
| --- | --- | --- |
| `backlinks` | `domain`, `limit?`, `sort?` (`authority` or `hosts`), `release_id?` | 1 backlinks call |
| `backlink_changes` | `domain`, `limit?`, `from_release?`, `to_release?` | 1 backlinks call |
| `gap_analysis` | `my_domain`, `competitor_domains[]` (1–5), `limit?`, `job_id?` | New submission: 1 gap job; polling/resume: 0 |
| `gap_outreach_targets` | Gap inputs plus `include_platforms?`, `enrich_authority_top?` | New submission: 1 gap job; optional N extra backlinks calls |
| `releases` | `limit?` | 0 |

Directory lists default to **20**, maximum **100**. The complete serialized
UTF-8 `CallToolResult`, including structured data, text and metadata, is
limited to **65,536 bytes**. Additional output clipping is disclosed in
`crawlgraph/output` metadata, retaining original observed totals, source caps,
quota accounting, provenance and job handles. Large exports belong on the
account/API surface.

Gap tools poll for at most **75 seconds within a 90-second tool budget**. A
pending result includes `job_id` and the normalized request. Resume the same
tool with that handle and query; a fresh valid grant for the same owner can
resume after reconnecting. Polling costs zero gap jobs. Never automatically
submit a replacement after timeout, cancellation, network loss or a stale
worker: the accepted job may still complete. Cancellation stops further
polling. An accepted submission remains charged; a lost/malformed response
reports unknown consumption rather than claiming zero.

Node writes bounded JSON telemetry to stderr. Each directory tool call records
an internally generated correlation ID, fixed tool name (or `unknown`), final
envelope status, `isError`, allowlisted primary and partial error codes, latency,
and the exact final serialized UTF-8 result size, excluding transport framing.
Known charged-call counts and unknown-consumption categories come from the
final envelope. Pending cancellations and completed results with partial
revocation retain their distinct status and error fields. HTTP/OAuth errors
record only a fixed route category, status, allowlisted code and a separate
response-local correlation ID. Logging failures cannot change responses.
Logs omit arguments, domains, results, job/account/grant/client/source IDs,
caller request IDs, exception text, URLs, headers, configuration and credentials.

OAuth source admission groups IPv6 addresses by /64 only in the local bucket
key; mapped IPv4 addresses use the same bucket as their IPv4 form. Private
RPCs still receive the full normalized verified ingress source. The bounded
bucket map fails closed at capacity without evicting live windows; the backend
continues enforcing its own policies.

Outreach preserves the backend ranking by competitor overlap, authority and
domain. Platform-filter counts describe only the returned backend sample.
Enrichment defaults to **0**; explicitly request `enrich_authority_top=N`
(**0–5**) for up to N extra backlinks calls on retained targets. Partial
failures retain completed results, per-item provenance, actual known charges,
the latest observed quota and any unknown consumption. Verified jobs use
their attested release for enrichment; legacy jobs keep null provenance and
record separate lookup releases.

Legacy tools retain their original fields and defaults: backlinks defaults to
1,000 rows at the public API, maximum 10,000; outreach uses `enrich_top`, default
10, maximum 25, with one backlinks call per enrichment. Legacy gap tools
submit and poll within their existing 90-second window and have no directory
`job_id` input. Check the selected profile before estimating quota use.

## Interpret results

Common Crawl is a periodic observation, not live link monitoring. Named
release provenance does not prove that a page currently links to a target.
A removed referring domain means it was not observed in the newer snapshot,
not proven live deletion. Unavailable comparison differs from zero changes;
unknown totals and source-capped lower bounds differ from complete empty
results. Gap provenance is saved at execution and retained on later polling.
Older unattested artifacts report `legacy_unverified` and null release
identity. A referring-domain overlap suggests a research candidate, not that
a publisher has never heard of you.

Example research prompt:

> Find backlink gaps for mine.example against a.example and b.example. If
> pending, resume the returned job without resubmitting. Report provenance,
> caps and quota use before proposing any optional authority enrichment.

## Develop and validate

```bash
npm install
npm run build
node --test tests/*.test.mjs
```

The build is also the TypeScript check; no separate lint script is configured.
Tests use the installed SDK, local HTTP fixtures and fake private/public
backend replies. They require permission to bind loopback sockets and never
need production credentials or live provider access. Node fixtures do not
prove the backend's SQLite transactions, quota isolation or query pinning;
separate crawlback backend HTTP tests and the full release gates cover those.

Implementation references: [HTTP surfaces](src/http.ts),
[OAuth router](src/oauth/router.ts), [provider](src/oauth/provider.ts),
[private backend client](src/backend-client.ts),
[directory tools](src/tool-profile.ts), and [legacy server](src/server.ts).

## License

MIT
