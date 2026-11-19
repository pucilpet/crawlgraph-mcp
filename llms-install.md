# Installing crawlgraph-mcp (for Cline / AI agents)

This server needs no build step and no cloning — it runs straight from npm via `npx`.

## Steps

1. Have the user obtain a CrawlGraph API key at https://crawlgraph.com/docs/api
   and set it in their local MCP configuration. Keys start with `cg_live_`.

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

3. On first run `npx` fetches the published `crawlgraph-mcp` package and its
   dependencies and starts the stdio server. No local compilation is required.

## Verifying it works

Call `releases` without arguments. A valid key returns a JSON list of Common
Crawl snapshots without using research quota. If you get an auth error, check
that the client passed a valid `CRAWLGRAPH_API_KEY` to the server.

## Tools exposed

- `backlinks` — referring domains for a target domain, with authority scores
- `backlink_changes` — referring domains added or missing between two Common Crawl snapshots
- `gap_analysis` — domains linking to a user's competitors but not to them
- `gap_outreach_targets` — domains linking to ALL the user's competitors but not
  them, de-noised and ranked by authority (the warm-outreach list)
- `releases` — list available Common Crawl snapshots (no quota cost)

## Notes

- Local stdio uses the `CRAWLGRAPH_API_KEY` environment variable.
- Optional `CRAWLGRAPH_BASE_URL` overrides the API host (default `https://crawlgraph.com`).
- Free accounts get 15 backlink calls per month. Paid accounts get 1,000 backlink
  calls and 50 gap-analysis jobs per month. `backlink_changes` uses one backlink call.
