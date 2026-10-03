/** Trusted legacy adapter: only the transport owner supplies the lazy API-key resolver. */
const BASE_URL = (process.env.CRAWLGRAPH_BASE_URL || "https://crawlgraph.com").replace(/\/+$/, "");

export class CrawlGraphError extends Error {}

export function createApiKeyClient(getApiKey: () => string, version: string) {
  const UA = `crawlgraph-mcp/${version}`;
  return async function api(method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
    const key = (getApiKey() || "").trim();
    if (!key) {
      throw new CrawlGraphError(
        "No CrawlGraph API key. For the hosted endpoint send 'Authorization: Bearer cg_live_...'; for the local server set CRAWLGRAPH_API_KEY. Get a key at https://crawlgraph.com/account.",
      );
    }
    // OAuth credentials must never cross the legacy public-REST boundary.
    if (key.startsWith("cgc_")) {
      throw new CrawlGraphError("Auth failed (401). Check the API key is a valid cg_live_ key for your crawlgraph account. ");
    }
    const res = await fetch(`${BASE_URL}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
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
      const detail = (
        json?.error || json?.message
          ? `${json.error ?? "error"}: ${json.message ?? ""}`
          : text.slice(0, 300)
      ).replaceAll(key, "[redacted]");
      if (res.status === 401 || res.status === 403) {
        throw new CrawlGraphError(
          `Auth failed (${res.status}). Check the API key is a valid cg_live_ key for your crawlgraph account. ${detail}`,
        );
      }
      if (res.status === 429) {
        throw new CrawlGraphError(`Rate limit or monthly quota exceeded (429). ${detail}`);
      }
      throw new CrawlGraphError(`API ${res.status}: ${detail}`);
    }
    return json;
  };
}
