#!/usr/bin/env node
/**
 * CrawlGraph MCP server — stdio entrypoint.
 *
 * Wraps the public CrawlGraph API (https://crawlgraph.com/docs/api) so any MCP
 * client (Claude Desktop, Claude Code, Cursor, Cline, Zed, Windsurf) can run
 * backlink lookups and competitor gap analysis on the Common Crawl webgraph.
 *
 * Auth: set CRAWLGRAPH_API_KEY (a `cg_live_...` token from your account page).
 * Tool definitions live in ./server.ts and are shared with the hosted HTTP
 * transport (./http.ts).
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";

async function main() {
  const server = buildServer(() => process.env.CRAWLGRAPH_API_KEY || "");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("crawlgraph-mcp running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
