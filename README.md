# crawlgraph-mcp

MCP server for the [CrawlGraph](https://crawlgraph.com) backlink-intelligence API. Gives any MCP client — Claude Desktop, Claude Code, Cursor, Cline, Zed, Windsurf — backlink lookups and competitor gap analysis built on the public [Common Crawl](https://commoncrawl.org) webgraph (4.4B edges, 120M domains).

> Backlink data without the $129/month subscription. CrawlGraph is $99 lifetime; API access is included on the lifetime tier.

## What you can do

- **`backlinks`** — every referring domain for a target, with authority scores
- **`gap_analysis`** — domains linking to your competitors but not to you
- **`gap_outreach_targets`** — the warm-outreach play: the domains that link to **all** of your competitors but not to you, ranked and de-noised. These are publishers who cover your whole space and have simply never heard of you — the warmest backlink targets you will ever pitch.
- **`releases`** — list the Common Crawl snapshots you can query

## Install

You need a CrawlGraph API key (`cg_live_...`) from your [account page](https://crawlgraph.com/account). API access is a lifetime-tier feature.

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

Same shape — point the client's MCP config at `npx -y crawlgraph-mcp` with `CRAWLGRAPH_API_KEY` in the env. Restart the client and the four tools appear.

## The outreach play, in one prompt

Once it's connected, you don't call the tools by hand — you describe the goal:

> "Use gap_outreach_targets for mydomain.com against competitor-a.com and competitor-b.com, then draft a short, specific outreach email to each priority target."

Behind the scenes the server submits the gap job, polls until it completes, filters the results down to the domains that link to **every** competitor but not to you, strips out platform/CDN noise (amazonaws, github, facebook, ...), and hands your agent a clean ranked list to write outreach against.

**Why 2-3 competitors, not one:** a site linking to one competitor might be a fluke or a paid placement. A site linking to three of your competitors is a publisher who covers your whole category. That overlap is the qualifier.

## Tools reference

| Tool | Arguments | Quota cost |
|------|-----------|------------|
| `backlinks` | `domain`, `limit?`, `sort?` (`authority`\|`hosts`), `release_id?` | 1 backlinks call |
| `gap_analysis` | `my_domain`, `competitor_domains[]` (1-5) | 1 gap job |
| `gap_outreach_targets` | `my_domain`, `competitor_domains[]` (2-5), `include_platforms?` | 1 gap job |
| `releases` | — | free |

Lifetime quota: 1,000 backlinks calls + 50 gap jobs per calendar month. Full API reference: [crawlgraph.com/docs/api](https://crawlgraph.com/docs/api).

## Configuration

| Env var | Required | Default |
|---------|----------|---------|
| `CRAWLGRAPH_API_KEY` | yes | — |
| `CRAWLGRAPH_BASE_URL` | no | `https://crawlgraph.com` |

## Limitations

CrawlGraph is a **quarterly** Common Crawl snapshot, not a live crawler. It's built for one-off competitor prospecting, not live backlink monitoring — for change-tracking within days, a continuous-crawl tool like Ahrefs is the right choice. The gap result carries which competitors each domain links to (`found_on`) but not per-domain authority; use the `backlinks` tool if you need to score an individual target.

## Develop

```bash
npm install
npm run build
CRAWLGRAPH_API_KEY=cg_live_... npm start
```

## License

MIT
