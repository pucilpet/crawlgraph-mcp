/**
 * Shared CrawlGraph MCP server definition.
 *
 * `buildServer(getApiKey)` returns a McpServer with the five tools wired up.
 * The API key is resolved lazily per call via `getApiKey`, so the same tool
 * definitions serve both transports:
 *   - stdio (src/index.ts): getApiKey reads process.env.CRAWLGRAPH_API_KEY
 *   - hosted HTTP (src/http.ts): getApiKey returns the per-request
 *     Authorization: Bearer <key>, making the hosted endpoint multi-tenant
 *     (each caller's own key is used for their own calls — never a shared one).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListResourcesRequestSchema, ListPromptsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createApiKeyClient, CrawlGraphError } from "./api-client.js";
import { buildDirectoryServer as createDirectoryServer, type DirectoryBackend, type DirectoryFactoryOptions } from "./tool-profile.js";
import type { ProtectedConnectorContext } from "./oauth/router.js";

export const VERSION = "0.4.0";
export { CrawlGraphError } from "./api-client.js";

export function buildDirectoryServer(context: ProtectedConnectorContext, backend: DirectoryBackend,
  options: Omit<DirectoryFactoryOptions, "version"> = {}): McpServer {
  return createDirectoryServer(context, backend, { ...options, version: VERSION });
}

const PLATFORM_NOISE = new Set([
  "amazonaws.com", "cloudfront.net", "googleusercontent.com", "azurewebsites.net",
  "herokuapp.com", "netlify.app", "vercel.app", "github.io", "githubusercontent.com",
  "cloudflare.com", "akamai.net", "fastly.net", "wp.com", "wordpress.com",
  "blogspot.com", "medium.com", "shopify.com", "myshopify.com", "wixsite.com",
  "squarespace.com", "weebly.com", "godaddy.com",
  "google.com", "youtube.com", "facebook.com", "instagram.com", "twitter.com",
  "x.com", "linkedin.com", "pinterest.com", "reddit.com", "tiktok.com",
  "apple.com", "microsoft.com", "adobe.com", "amazon.com", "alibaba.com",
  "yahoo.com", "bing.com", "wikipedia.org", "archive.org", "gravatar.com",
  "bit.ly", "t.co", "goo.gl", "ow.ly", "feedburner.com", "doubleclick.net",
]);

function isPlatformNoise(domain: string): boolean {
  const d = domain.toLowerCase();
  if (PLATFORM_NOISE.has(d)) return true;
  return [...PLATFORM_NOISE].some((p) => d === p || d.endsWith("." + p));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Output schemas ────────────────────────────────────────────────────────────
// Declared on each tool (outputSchema) so clients get a typed contract, and
// mirrored by the `structuredContent` each handler returns. Shapes match the
// curated objects the handlers build (not the raw API body), so validation is
// stable even if the API adds fields.
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

const backlinkRowShape = {
  linking_domain: z.string(),
  num_hosts: z.number(),
  tld: z.string().optional(),
  cg_authority: z.number().nullable(),
  cg_rank: z.number().nullable(),
};

const backlinksOutputShape = {
  domain: z.string(),
  release_id: z.string(),
  release_label: z.string(),
  total_linking_domains: z.number(),
  returned: z.number(),
  cg_authority: z.number().nullable(),
  cg_rank: z.number().nullable(),
  results: z.array(z.object(backlinkRowShape)),
};

const gapAnalysisOutputShape = {
  my_domain: z.string(),
  competitor_domains: z.array(z.string()),
  total_gaps: z.number(),
  gaps: z.array(z.object({ linking_domain: z.string(), found_on: z.array(z.string()) })),
};

const outreachTargetShape = {
  linking_domain: z.string(),
  found_on: z.array(z.string()),
  overlap: z.number(),
  cg_authority: z.number().nullable().optional(),
  cg_rank: z.number().nullable().optional(),
};

const outreachOutputShape = {
  my_domain: z.string(),
  competitor_domains: z.array(z.string()),
  priority_targets: z.array(z.object(outreachTargetShape)),
  secondary_targets: z.array(z.object(outreachTargetShape)),
  total_gaps: z.number(),
  platforms_filtered: z.number(),
  authority_enriched: z.number(),
};

const releasesOutputShape = {
  releases: z.array(z.object({ id: z.string(), label: z.string(), available: z.boolean() })),
};

const backlinkChangesReleaseShape = {
  id: z.string(),
  label: z.string(),
};

const backlinkChangesObservedDomainShape = {
  linking_domain: z.string(),
  num_hosts: z.number(),
  cg_authority: z.number().nullable(),
};

const backlinkChangesOutputShape = {
  domain: z.string(),
  comparison_available: z.boolean(),
  from_release: z.object(backlinkChangesReleaseShape).nullable(),
  to_release: z.object(backlinkChangesReleaseShape),
  counts: z.object({
    from_snapshot: z.number(),
    to_snapshot: z.number(),
    added: z.number(),
    removed: z.number(),
    authority_moved: z.number(),
  }),
  added: z.array(z.object(backlinkChangesObservedDomainShape)),
  removed: z.array(z.object(backlinkChangesObservedDomainShape)),
  authority_moved: z.array(z.object({
    linking_domain: z.string(),
    from_authority: z.number(),
    to_authority: z.number(),
    delta: z.number(),
  })),
  truncated: z.boolean(),
  cap: z.number(),
  snapshot_caveat: z.string(),
  message: z.string().optional(),
};

export function buildServer(getApiKey: () => string): McpServer {
  const api = createApiKeyClient(getApiKey, VERSION);

  async function domainAuthority(domain: string): Promise<{ cg_authority: number | null; cg_rank: number | null }> {
    const data = await api("POST", "/backlinks", { domain, limit: 1 });
    return { cg_authority: data?.cg_authority ?? null, cg_rank: data?.cg_rank ?? null };
  }

  async function runGapJob(myDomain: string, competitors: string[], maxWaitMs = 90_000): Promise<any> {
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
      if (status.status === "completed") return status.result;
      if (status.status === "failed") {
        throw new CrawlGraphError(`gap-analysis job ${jobId} failed: ${status.error?.message || "failed"}`);
      }
      delay = Math.min(delay + 1000, 5000);
    }
    throw new CrawlGraphError(
      `gap-analysis job ${jobId} did not finish within ${Math.round(maxWaitMs / 1000)}s; re-run or poll /api/v1/gap-analysis/${jobId}.`,
    );
  }

  const server = new McpServer(
    { name: "crawlgraph", version: VERSION },
    // CrawlGraph is tools-only, but clients (Smithery, etc.) probe all three
    // capability types on connect. Advertise empty resources/prompts so those
    // probes return [] instead of a "-32601 Method not found" warning.
    { capabilities: { resources: {}, prompts: {} } },
  );
  server.server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
  server.server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));

  server.registerTool(
    "backlinks",
    {
      title: "Backlink lookup",
      description:
        "Look up referring domains (backlinks) for a single target domain from the " +
        "Common Crawl webgraph. Returns each linking domain with host count and " +
        "CrawlGraph authority score, plus the target's own authority/rank. " +
        "Costs one backlinks call against the monthly quota (1,000/mo for lifetime or eligible monthly paid access). " +
        "These snapshot observations do not prove live links.",
      inputSchema: {
        domain: z.string().min(1).max(253).describe("Target domain, e.g. 'stripe.com'."),
        limit: z.number().int().min(1).max(10000).optional().describe("Max rows (1..10000, default 1000)."),
        sort: z.enum(["authority", "hosts"]).optional().describe("'authority' (default) or 'hosts'."),
        release_id: z.string().optional().describe("Common Crawl release id (defaults to latest; see the releases tool)."),
      },
      outputSchema: backlinksOutputShape,
      annotations: { title: "Backlink lookup", ...READ_ONLY },
    },
    async ({ domain, limit, sort, release_id }) => {
      const data = await api("POST", "/backlinks", {
        domain,
        ...(limit !== undefined ? { limit } : {}),
        ...(sort !== undefined ? { sort } : {}),
        ...(release_id !== undefined ? { release_id } : {}),
      });
      const structuredContent = {
        domain: data.domain,
        release_id: data.release_id,
        release_label: data.release_label,
        total_linking_domains: data.total_linking_domains,
        returned: data.returned,
        cg_authority: data.cg_authority ?? null,
        cg_rank: data.cg_rank ?? null,
        results: (data.results || []).map((r: any) => ({
          linking_domain: r.linking_domain,
          num_hosts: r.num_hosts,
          tld: r.tld,
          cg_authority: r.cg_authority ?? null,
          cg_rank: r.cg_rank ?? null,
        })),
      };
      const summary =
        `${data.domain} — ${data.total_linking_domains} referring domains ` +
        `(release ${data.release_label}). Showing ${data.returned}. ` +
        `Target authority: ${data.cg_authority ?? "n/a"}/100.`;
      return { content: [{ type: "text", text: summary }, { type: "text", text: JSON.stringify(structuredContent, null, 2) }], structuredContent };
    },
  );

  server.registerTool(
    "backlink_changes",
    {
      title: "Backlink changes between releases",
      description:
        "Compare referring-domain observations between two Common Crawl releases. "+
        "When from_release and to_release are omitted, the API chooses the newest "+
        "queryable release pair. Costs one backlinks call against the monthly quota. "+
        "A removed domain means it was not observed in the newer Common Crawl snapshot, "+
        "not that deletion from the live web has been proven. comparison_available: false "+
        "is a valid successful response when two queryable snapshots do not exist.",
      inputSchema: {
        domain: z.string().min(1).max(253).describe("Target domain, e.g. 'example.com'."),
        from_release: z.string().optional().describe("Older Common Crawl release id."),
        to_release: z.string().optional().describe("Newer Common Crawl release id."),
      },
      outputSchema: backlinkChangesOutputShape,
      annotations: { title: "Backlink changes between releases", ...READ_ONLY },
    },
    async ({ domain, from_release, to_release }) => {
      const params = new URLSearchParams({ domain });
      if (from_release !== undefined) params.set("from", from_release);
      if (to_release !== undefined) params.set("to", to_release);
      const data = await api("GET", `/changes?${params.toString()}`);
      const structuredContent = {
        domain: data.domain,
        comparison_available: data.comparison_available,
        from_release: data.from_release
          ? { id: data.from_release.id, label: data.from_release.label }
          : null,
        to_release: { id: data.to_release.id, label: data.to_release.label },
        counts: {
          from_snapshot: data.counts.from_snapshot,
          to_snapshot: data.counts.to_snapshot,
          added: data.counts.added,
          removed: data.counts.removed,
          authority_moved: data.counts.authority_moved,
        },
        added: (data.added || []).map((row: any) => ({
          linking_domain: row.linking_domain,
          num_hosts: row.num_hosts,
          cg_authority: row.cg_authority ?? null,
        })),
        removed: (data.removed || []).map((row: any) => ({
          linking_domain: row.linking_domain,
          num_hosts: row.num_hosts,
          cg_authority: row.cg_authority ?? null,
        })),
        authority_moved: (data.authority_moved || []).map((row: any) => ({
          linking_domain: row.linking_domain,
          from_authority: row.from_authority,
          to_authority: row.to_authority,
          delta: row.delta,
        })),
        truncated: data.truncated,
        cap: data.cap,
        ...(data.message !== undefined ? { message: data.message } : {}),
        snapshot_caveat: data.snapshot_caveat,
      };
      const comparisonSummary = data.comparison_available
        ? `${data.counts.added} added, ${data.counts.removed} removed, `+
          `${data.counts.authority_moved} authority moved`
        : "comparison unavailable";
      const summary =
        `${data.domain}: ${comparisonSummary}. `+
        "Default comparison is the newest queryable release pair. Costs one backlinks call. "+
        "Removed domains mean not observed in the newer Common Crawl snapshot, not proven "+
        "deletion from the live web. comparison_available: false is a valid response when "+
        "two queryable snapshots do not exist.";
      return {
        content: [
          { type: "text", text: summary },
          { type: "text", text: JSON.stringify(structuredContent, null, 2) },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "gap_analysis",
    {
      title: "Competitor backlink gap analysis",
      description:
        "Run a competitor backlink gap analysis: find domains observed linking to one or more " +
        "of your competitors but NOT to you. Submits an async job and polls until done " +
        "(usually 5-30s). Returns every gap with `found_on` listing which competitors " +
        "each domain was observed linking to. Costs one gap job against the monthly quota " +
        "(50/mo for lifetime or eligible monthly paid access). These observations do not prove live links.",
      inputSchema: {
        my_domain: z.string().min(1).max(253).describe("Your domain."),
        competitor_domains: z.array(z.string().min(1).max(253)).min(1).max(5).describe("1 to 5 competitor domains."),
      },
      outputSchema: gapAnalysisOutputShape,
      annotations: { title: "Competitor backlink gap analysis", ...READ_ONLY },
    },
    async ({ my_domain, competitor_domains }) => {
      const result = await runGapJob(my_domain, competitor_domains);
      const structuredContent = {
        my_domain: result.my_domain,
        competitor_domains: result.competitor_domains,
        total_gaps: result.total_gaps,
        gaps: (result.gaps || []).map((g: any) => ({ linking_domain: g.linking_domain, found_on: g.found_on || [] })),
      };
      const summary =
        `${result.total_gaps} gap domains link to a competitor but not to ${result.my_domain} ` +
        `(competitors: ${result.competitor_domains.join(", ")}).`;
      return { content: [{ type: "text", text: summary }, { type: "text", text: JSON.stringify(structuredContent, null, 2) }], structuredContent };
    },
  );

  server.registerTool(
    "gap_outreach_targets",
    {
      title: "Outreach target finder",
      description:
        "The warm-outreach play. Runs a gap analysis, then ranks results: PRIORITY = " +
        "domains observed linking to ALL your competitors but not you (research candidates, " +
        "without proof of live links or publisher awareness), SECONDARY = domains observed linking to 2+ " +
        "competitors. Platform/CDN noise is filtered, top N priority targets are scored " +
        "by authority. Use 2-3 competitors. Costs one gap job + one backlinks call per enriched target.",
      inputSchema: {
        my_domain: z.string().min(1).max(253).describe("Your domain."),
        competitor_domains: z.array(z.string().min(1).max(253)).min(2).max(5).describe("2 to 5 competitor domains (2-3 recommended)."),
        include_platforms: z.boolean().optional().describe("Keep platform/CDN/social domains in the list. Default false."),
        enrich_top: z.number().int().min(0).max(25).optional().describe("Authority-score the top N priority targets. Default 10; each costs one backlinks call. 0 disables."),
      },
      outputSchema: outreachOutputShape,
      annotations: { title: "Outreach target finder", ...READ_ONLY },
    },
    async ({ my_domain, competitor_domains, include_platforms, enrich_top }) => {
      const result = await runGapJob(my_domain, competitor_domains);
      const total = competitor_domains.length;
      const rawGaps: Array<{ linking_domain: string; found_on: string[] }> = result.gaps || [];
      let filteredOut = 0;
      const gaps = rawGaps.filter((g) => {
        if (include_platforms) return true;
        if (isPlatformNoise(g.linking_domain)) { filteredOut++; return false; }
        return true;
      });
      const ranked = gaps
        .map((g) => ({ linking_domain: g.linking_domain, found_on: g.found_on || [], overlap: (g.found_on || []).length }))
        .sort((a, b) => b.overlap - a.overlap || a.linking_domain.localeCompare(b.linking_domain));
      const priority: Array<{ linking_domain: string; found_on: string[]; overlap: number; cg_authority?: number | null; cg_rank?: number | null }> =
        ranked.filter((g) => g.overlap >= total);
      const secondary = ranked.filter((g) => g.overlap >= 2 && g.overlap < total);
      const enrichN = enrich_top === undefined ? 10 : enrich_top;
      let enrichedCount = 0;
      if (enrichN > 0 && priority.length > 0) {
        const toEnrich = priority.slice(0, enrichN);
        for (const target of toEnrich) {
          try {
            const { cg_authority, cg_rank } = await domainAuthority(target.linking_domain);
            target.cg_authority = cg_authority;
            target.cg_rank = cg_rank;
            enrichedCount++;
          } catch {
            target.cg_authority = null;
            break;
          }
          await sleep(250);
        }
        const enrichedSlice = priority.slice(0, toEnrich.length).sort((a, b) => {
          const aa = a.cg_authority ?? -1;
          const bb = b.cg_authority ?? -1;
          return bb - aa || a.linking_domain.localeCompare(b.linking_domain);
        });
        priority.splice(0, enrichedSlice.length, ...enrichedSlice);
      }
      const summary =
        `${priority.length} PRIORITY targets (link to all ${total} competitors but not ${my_domain}), ` +
        `${secondary.length} secondary (link to 2+). ` +
        (filteredOut ? `${filteredOut} platform/CDN domains filtered out. ` : "") +
        (enrichedCount ? `Top ${enrichedCount} scored by authority. ` : "") +
        `Pitch the priority list first — they already link to your whole category.`;
      const structuredContent = {
        my_domain,
        competitor_domains,
        priority_targets: priority,
        secondary_targets: secondary,
        total_gaps: result.total_gaps,
        platforms_filtered: include_platforms ? 0 : filteredOut,
        authority_enriched: enrichedCount,
      };
      return {
        content: [
          { type: "text", text: summary },
          { type: "text", text: JSON.stringify(structuredContent, null, 2) },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "releases",
    {
      title: "List Common Crawl releases",
      description:
        "List the Common Crawl releases the API can query. Does not count against any quota. " +
        "Use a release `id` with the backlinks tool to query a specific snapshot.",
      outputSchema: releasesOutputShape,
      annotations: { title: "List Common Crawl releases", ...READ_ONLY },
    },
    async () => {
      const data = await api("GET", "/releases");
      const structuredContent = {
        releases: (data.releases || []).map((r: any) => ({ id: r.id, label: r.label, available: !!r.available })),
      };
      return { content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }], structuredContent };
    },
  );

  return server;
}
