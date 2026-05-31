#!/usr/bin/env node
/**
 * CrawlGraph MCP server.
 *
 * Wraps the public CrawlGraph API (https://crawlgraph.com/docs/api) so any
 * MCP client (Claude Desktop, Cursor, Cline, Zed, Windsurf, Claude Code, ...)
 * can run backlink lookups and competitor gap analysis on the Common Crawl
 * webgraph.
 *
 * Auth: set CRAWLGRAPH_API_KEY (a `cg_live_...` token from your account page).
 * API access is a lifetime-tier feature.
 *
 * Tools:
 *   - backlinks              : referring domains for a single target
 *   - gap_analysis           : submit + poll a competitor gap job, return raw gaps
 *   - gap_outreach_targets   : composite — the warm outreach list (domains linking
 *                              to ALL your competitors but not to you), ranked
 *   - releases               : list available Common Crawl releases
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = (process.env.CRAWLGRAPH_BASE_URL || "https://crawlgraph.com").replace(/\/+$/, "");
const API_KEY = process.env.CRAWLGRAPH_API_KEY || "";

const UA = "crawlgraph-mcp/0.1.0";

class CrawlGraphError extends Error {}

async function api(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<any> {
  if (!API_KEY) {
    throw new CrawlGraphError(
      "CRAWLGRAPH_API_KEY is not set. Get a cg_live_ key from https://crawlgraph.com/account and set it in the MCP server env.",
    );
  }
  const res = await fetch(`${BASE_URL}/api/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      "User-Agent": UA,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error body */
  }

  if (!res.ok) {
    const detail =
      json?.error || json?.message
        ? `${json.error ?? "error"}: ${json.message ?? ""}`
        : text.slice(0, 300);
    if (res.status === 401 || res.status === 403) {
      throw new CrawlGraphError(
        `Auth failed (${res.status}). Check CRAWLGRAPH_API_KEY is a valid cg_live_ key and your account has lifetime API access. ${detail}`,
      );
    }
    if (res.status === 429) {
      throw new CrawlGraphError(
        `Rate limit or monthly quota exceeded (429). ${detail}`,
      );
    }
    throw new CrawlGraphError(`API ${res.status}: ${detail}`);
  }
  return json;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Submit a gap-analysis job and poll until it completes or times out.
 * Returns the completed result object: {my_domain, competitor_domains, gaps, total_gaps}.
 */
async function runGapJob(
  myDomain: string,
  competitors: string[],
  maxWaitMs = 90_000,
): Promise<any> {
  const submit = await api("POST", "/gap-analysis", {
    my_domain: myDomain,
    competitor_domains: competitors,
  });
  const jobId: string = submit.job_id;
  if (!jobId) throw new CrawlGraphError("gap-analysis submit returned no job_id");

  const deadline = Date.now() + maxWaitMs;
  let delay = 1500;
  while (Date.now() < deadline) {
    await sleep(delay);
    const status = await api("GET", `/gap-analysis/${jobId}`);
    if (status.status === "completed") {
      return status.result;
    }
    if (status.status === "failed") {
      const msg = status.error?.message || "gap job failed";
      throw new CrawlGraphError(`gap-analysis job ${jobId} failed: ${msg}`);
    }
    // queued | running — back off a little, cap at 5s
    delay = Math.min(delay + 1000, 5000);
  }
  throw new CrawlGraphError(
    `gap-analysis job ${jobId} did not finish within ${Math.round(maxWaitMs / 1000)}s. It may still complete; re-run or poll /api/v1/gap-analysis/${jobId}.`,
  );
}

const server = new McpServer({
  name: "crawlgraph",
  version: "0.1.0",
});

// ── Tool 1: backlinks ────────────────────────────────────────────────────────
server.tool(
  "backlinks",
  "Look up referring domains (backlinks) for a single target domain from the " +
    "Common Crawl webgraph. Returns each linking domain with its host count and " +
    "CrawlGraph authority score, plus the target's own authority/rank. " +
    "Costs one backlinks call against the monthly quota (1,000/mo on lifetime).",
  {
    domain: z.string().min(1).max(253).describe("Target domain, e.g. 'stripe.com'."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(10000)
      .optional()
      .describe("Max rows to return (1..10000, default 1000)."),
    sort: z
      .enum(["authority", "hosts"])
      .optional()
      .describe("'authority' (default) or 'hosts'."),
    release_id: z
      .string()
      .optional()
      .describe("Common Crawl release id (defaults to latest; see the releases tool)."),
  },
  async ({ domain, limit, sort, release_id }) => {
    const data = await api("POST", "/backlinks", {
      domain,
      ...(limit !== undefined ? { limit } : {}),
      ...(sort !== undefined ? { sort } : {}),
      ...(release_id !== undefined ? { release_id } : {}),
    });
    const summary =
      `${data.domain} — ${data.total_linking_domains} referring domains ` +
      `(release ${data.release_label}). Showing ${data.returned}. ` +
      `Target authority: ${data.cg_authority ?? "n/a"}/100.`;
    return {
      content: [
        { type: "text", text: summary },
        { type: "text", text: JSON.stringify(data, null, 2) },
      ],
    };
  },
);

// ── Tool 2: gap_analysis ─────────────────────────────────────────────────────
server.tool(
  "gap_analysis",
  "Run a competitor backlink gap analysis: find domains that link to one or more " +
    "of your competitors but NOT to you. Submits an async job and polls until done " +
    "(usually 5-30s). Returns every gap with `found_on` listing which competitors " +
    "each domain links to. Costs one gap job against the monthly quota (50/mo on lifetime).",
  {
    my_domain: z.string().min(1).max(253).describe("Your domain."),
    competitor_domains: z
      .array(z.string().min(1).max(253))
      .min(1)
      .max(5)
      .describe("1 to 5 competitor domains."),
  },
  async ({ my_domain, competitor_domains }) => {
    const result = await runGapJob(my_domain, competitor_domains);
    const summary =
      `${result.total_gaps} gap domains link to a competitor but not to ${result.my_domain} ` +
      `(competitors: ${result.competitor_domains.join(", ")}).`;
    return {
      content: [
        { type: "text", text: summary },
        { type: "text", text: JSON.stringify(result, null, 2) },
      ],
    };
  },
);

/**
 * Platform / CDN / infrastructure domains that show up in almost every
 * backlink profile and are never real outreach targets. Filtered out of
 * the outreach list by default (set include_platforms=true to keep them).
 * Matched on the registrable-domain suffix so subdomains are covered.
 */
const PLATFORM_NOISE = new Set([
  // hosting / cloud / cdn
  "amazonaws.com", "cloudfront.net", "googleusercontent.com", "azurewebsites.net",
  "herokuapp.com", "netlify.app", "vercel.app", "github.io", "githubusercontent.com",
  "cloudflare.com", "akamai.net", "fastly.net", "wp.com", "wordpress.com",
  "blogspot.com", "medium.com", "shopify.com", "myshopify.com", "wixsite.com",
  "squarespace.com", "weebly.com", "godaddy.com",
  // big platforms / social
  "google.com", "youtube.com", "facebook.com", "instagram.com", "twitter.com",
  "x.com", "linkedin.com", "pinterest.com", "reddit.com", "tiktok.com",
  "apple.com", "microsoft.com", "adobe.com", "amazon.com", "alibaba.com",
  "yahoo.com", "bing.com", "wikipedia.org", "archive.org", "gravatar.com",
  // url shorteners / trackers
  "bit.ly", "t.co", "goo.gl", "ow.ly", "feedburner.com", "doubleclick.net",
]);

function isPlatformNoise(domain: string): boolean {
  const d = domain.toLowerCase();
  if (PLATFORM_NOISE.has(d)) return true;
  // suffix match: foo.amazonaws.com -> amazonaws.com
  return [...PLATFORM_NOISE].some((p) => d === p || d.endsWith("." + p));
}

// ── Tool 3: gap_outreach_targets (composite) ─────────────────────────────────
server.tool(
  "gap_outreach_targets",
  "The warm-outreach play. Runs a gap analysis, then ranks the results into a " +
    "prioritised outreach list: PRIORITY = domains linking to ALL of your " +
    "competitors but not to you (publishers who cover your whole space and have " +
    "simply never heard of you — the warmest backlink targets you will ever pitch), " +
    "SECONDARY = domains linking to 2+ competitors. Use 2-3 competitors for the " +
    "sharpest signal. Costs one gap job against the monthly quota.",
  {
    my_domain: z.string().min(1).max(253).describe("Your domain."),
    competitor_domains: z
      .array(z.string().min(1).max(253))
      .min(2)
      .max(5)
      .describe("2 to 5 competitor domains (2-3 recommended)."),
    include_platforms: z
      .boolean()
      .optional()
      .describe(
        "Keep platform/CDN/social domains (amazonaws, github, facebook, ...) in the list. Default false — they are filtered out as non-outreachable noise.",
      ),
  },
  async ({ my_domain, competitor_domains, include_platforms }) => {
    const result = await runGapJob(my_domain, competitor_domains);
    const total = competitor_domains.length;
    const rawGaps: Array<{ linking_domain: string; found_on: string[] }> = result.gaps || [];

    let filteredOut = 0;
    const gaps = rawGaps.filter((g) => {
      if (include_platforms) return true;
      if (isPlatformNoise(g.linking_domain)) {
        filteredOut++;
        return false;
      }
      return true;
    });

    const ranked = gaps
      .map((g) => ({
        linking_domain: g.linking_domain,
        found_on: g.found_on || [],
        overlap: (g.found_on || []).length,
      }))
      .sort(
        (a, b) =>
          b.overlap - a.overlap || a.linking_domain.localeCompare(b.linking_domain),
      );

    const priority = ranked.filter((g) => g.overlap >= total);
    const secondary = ranked.filter((g) => g.overlap >= 2 && g.overlap < total);

    const summary =
      `${priority.length} PRIORITY targets (link to all ${total} competitors but not ${my_domain}), ` +
      `${secondary.length} secondary (link to 2+). ` +
      (filteredOut ? `${filteredOut} platform/CDN domains filtered out. ` : "") +
      `Pitch the priority list first — they already link to your whole category.`;

    return {
      content: [
        { type: "text", text: summary },
        {
          type: "text",
          text: JSON.stringify(
            {
              my_domain,
              competitor_domains,
              priority_targets: priority,
              secondary_targets: secondary,
              total_gaps: result.total_gaps,
              platforms_filtered: include_platforms ? 0 : filteredOut,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ── Tool 4: releases ─────────────────────────────────────────────────────────
server.tool(
  "releases",
  "List the Common Crawl releases the API can query. Does not count against any quota. " +
    "Use a release `id` with the backlinks tool to query a specific snapshot.",
  {},
  async () => {
    const data = await api("GET", "/releases");
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr so we don't corrupt the stdio JSON-RPC stream on stdout
  console.error("crawlgraph-mcp running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
