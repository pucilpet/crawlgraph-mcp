---
name: crawlgraph-backlink-research
description: Research referring domains, competitor link gaps, outreach candidates, and changes between named Common Crawl snapshots with the CrawlGraph MCP tools. Use when a user asks which sites link to a domain, which domains link to competitors but not their site, or how a backlink profile changed between available releases.
---

# CrawlGraph backlink research

Use the connected `crawlgraph` MCP server. Treat every result as an observation from the named Common Crawl release, not a live or complete backlink index.

## Choose the tool

- `backlinks`: look up referring domains for one domain. Start with the default limit and increase only when needed.
- `gap_analysis`: compare one domain with competitor domains to find link gaps.
- `gap_outreach_targets`: find and rank gap domains for outreach research. This does not send messages or create contacts.
- `backlink_changes`: compare available releases for one domain.
- `releases`: inspect available release identifiers and metadata before release-specific research.

## Preserve quotas and job identity

Free accounts have 15 backlink lookups and zero gap jobs per UTC month. Paid accounts have 1,000 backlink lookups and 50 gap jobs per UTC month. Release inventory is free. Backlink changes share the backlink quota.

Gap tools can return a pending result with a `job_id`. Resume that same job instead of submitting a replacement. Polling and resume calls do not consume another gap job. Do not retry after a timeout, cancellation, network loss, or ambiguous response without reconciling the existing job.

Optional outreach authority enrichment consumes additional backlink calls. Ask before enabling it unless the user already authorized the extra quota use.

## Report evidence and limits

Include the release identity, observed totals, result caps, output clipping, and quota information when present. A referring-domain overlap is a research candidate, not proof that a publisher will accept outreach. A domain missing from a newer snapshot is not proof that a live link was deleted. Verify important source pages before making outreach or link-reclamation decisions.
