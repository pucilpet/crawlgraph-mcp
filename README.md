# crawlgraph-mcp

MCP server for the [CrawlGraph](https://crawlgraph.com) backlink-intelligence API. Gives any MCP client — Claude Desktop, Claude Code, Cursor, Cline, Zed, Windsurf — backlink lookups and competitor gap analysis built on the public [Common Crawl](https://commoncrawl.org) webgraph (4.4B edges, 120M domains).

> Backlink data without the $129/month subscription. CrawlGraph is $99 lifetime; API access is included on the lifetime tier.

## What you can do

- **`backlinks`** — every referring domain for a target, with authority scores
- **`gap_analysis`** — domains linking to your competitors but not to you
- **`gap_outreach_targets`** — the warm-outreach play: the domains that link to **all** of your competitors but not to you, ranked and de-noised. These are publishers who cover your whole space and have simply never heard of you — the warmest backlink targets you will ever pitch.
- **`backlink_changes`** — additions, observed absences, and authority movement between Common Crawl snapshots
- **`releases`** — list the Common Crawl snapshots you can query

## Install

You need a CrawlGraph API key (`cg_live_...`). **Free tier: 15 backlink calls/month, no card** - get a key emailed to you at [crawlgraph.com/docs/api](https://crawlgraph.com/docs/api). The `gap_analysis` and `gap_outreach_targets` tools need the [$99 lifetime tier](https://crawlgraph.com) (1,000 calls + 50 gap analyses/month, no subscription).

### Claude Desktop / Claude Code

Add to your MCP config (`claude_desktop_config.json`, or `.mcp.json` for Claude Code):

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

### Cursor / Windsurf / Cline / Zed

Same shape — point the client's MCP config at `npx -y crawlgraph-mcp` with `CRAWLGRAPH_API_KEY` in the env. Restart the client and the five tools appear.

### Hosted endpoint

Clients that support Streamable HTTP can use the zero-install hosted endpoint
at `https://crawlgraph.com/mcp` with the same bearer key. This package's local
0.3.0 server exposes the five tools above; hosted package versions are released
separately and must be verified with `tools/list` before relying on the new
`backlink_changes` tool. See the [hosted MCP smoke runbook](https://github.com/pucilpet/crawlback/blob/master/docs/ops/hosted-mcp-smoke.md)
for the operator-owned release and verification process.

## The outreach play, in one prompt

Once it's connected, you don't call the tools by hand — you describe the goal:

> "Use gap_outreach_targets for mydomain.com against competitor-a.com and competitor-b.com, then draft a short, specific outreach email to each priority target."

Behind the scenes the server submits the gap job, polls until it completes, filters the results down to the domains that link to **every** competitor but not to you, strips out platform/CDN noise (amazonaws, github, facebook, ...), and hands your agent a clean ranked list to write outreach against.

**Why 2-3 competitors, not one:** a site linking to one competitor might be a fluke or a paid placement. A site linking to three of your competitors is a publisher who covers your whole category. That overlap is the qualifier.

## Tools reference

| Tool | Arguments | Quota cost |
|------|-----------|------------|
| `backlinks` | `domain`, `limit?`, `sort?` (`authority`\|`hosts`), `release_id?` | 1 backlinks call |
| `backlink_changes` | `domain`, `from_release?`, `to_release?` | 1 backlinks call |
| `gap_analysis` | `my_domain`, `competitor_domains[]` (1-5) | 1 gap job |
| `gap_outreach_targets` | `my_domain`, `competitor_domains[]` (2-5), `include_platforms?` | 1 gap job |
| `releases` | — | free |

Lifetime quota: 1,000 backlinks calls + 50 gap jobs per calendar month. Full API reference: [crawlgraph.com/docs/api](https://crawlgraph.com/docs/api).

`backlink_changes` uses the newest queryable release pair when release ids are
omitted. Its `removed` list means a referring domain was not observed in the
newer Common Crawl snapshot, not that a live link was proven deleted. If two
queryable snapshots do not exist, it returns a successful
`comparison_available: false` response with the reason instead of inventing a
comparison.

Example input:

```json
{
  "domain": "example.com",
  "from_release": "cc-main-2025-50",
  "to_release": "cc-main-2026-04"
}
```

Example output (abbreviated):

```json
{
  "domain": "example.com",
  "comparison_available": true,
  "from_release": { "id": "cc-main-2025-50", "label": "Dec 2025" },
  "to_release": { "id": "cc-main-2026-04", "label": "Apr 2026" },
  "counts": { "from_snapshot": 4821, "to_snapshot": 4890, "added": 92, "removed": 23, "authority_moved": 17 },
  "added": [],
  "removed": [],
  "authority_moved": [],
  "truncated": false,
  "cap": 100000,
  "snapshot_caveat": "Common Crawl snapshots are periodic observations, not live link monitoring."
}
```

## Configuration

| Env var | Required | Default |
|---------|----------|---------|
| `CRAWLGRAPH_API_KEY` | yes | — |
| `CRAWLGRAPH_BASE_URL` | no | `https://crawlgraph.com` |

## Limitations

CrawlGraph is a **quarterly** Common Crawl snapshot, not a live crawler. It's built for one-off competitor prospecting and release-to-release comparison, not live backlink monitoring — for change-tracking within days, a continuous-crawl tool like Ahrefs is the right choice. The `backlink_changes` tool reports observations across indexed snapshots; an absent domain is not proof that a live link was deleted. The gap result carries which competitors each domain links to (`found_on`) but not per-domain authority; use the `backlinks` tool if you need to score an individual target.

## Develop

```bash
npm install
npm run build
CRAWLGRAPH_API_KEY=cg_live_... npm start
```

## License

MIT
