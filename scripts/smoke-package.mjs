import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [command, version, ...args] = process.argv.slice(2);
const client = new Client({ name: "crawlgraph-package-smoke", version: "1.0.0" });
const transport = new StdioClientTransport({ command, args, stderr: "inherit" });

try {
  await client.connect(transport, { timeout: 10_000 });
  assert.deepEqual(client.getServerVersion(), { name: "crawlgraph", version });
  const { tools } = await client.listTools(undefined, { timeout: 10_000 });
  assert.deepEqual(tools.map(({ name }) => name).sort(), [
    "backlink_changes", "backlinks", "gap_analysis", "gap_outreach_targets", "releases",
  ]);
} finally {
  await client.close();
}
