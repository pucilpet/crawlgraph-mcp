# Installing crawlgraph-mcp (for Cline / AI agents)

This server needs no build step and no cloning — it runs straight from npm via `npx`.

## Steps

1. Ask the user for their CrawlGraph API key. It looks like `cg_live_...` and is
   created at https://crawlgraph.com/account (lifetime-tier feature).

2. Add this to the user's MCP settings (`cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "crawlgraph": {
      "command": "npx",
      "args": ["-y", "crawlgraph-mcp"],
      "env": {
        "CRAWLGRAPH_API_KEY": "cg_live_THE_USERS_KEY"
      }
    }
  }
}
```

3. That's it. On first run `npx` fetches the published `crawlgraph-mcp` package
   and starts the stdio server. No other dependencies, no compilation.

## Verifying it works

Call the `releases` tool (it needs no arguments and no quota). A valid key returns
a JSON list of Common Crawl releases. If you get an auth error, the
`CRAWLGRAPH_API_KEY` is missing, wrong, or the account is not on the lifetime tier.

## Tools exposed

- `backlinks` — referring domains for a target domain, with authority scores
- `gap_analysis` — domains linking to a user's competitors but not to them
- `gap_outreach_targets` — domains linking to ALL the user's competitors but not
  them, de-noised and ranked by authority (the warm-outreach list)
- `releases` — list available Common Crawl snapshots (no quota cost)

## Notes

- Auth is a single env var: `CRAWLGRAPH_API_KEY`. No OAuth, no config files.
- Optional `CRAWLGRAPH_BASE_URL` overrides the API host (default `https://crawlgraph.com`).
- Quotas (lifetime tier): 1,000 backlink lookups + 50 gap-analysis jobs per month.
