# Hosted endpoint deployment

The hosted remote MCP server runs at **https://crawlgraph.com/mcp** (Streamable
HTTP transport, stateless, multi-tenant — each request carries the caller's own
`Authorization: Bearer cg_live_…` key).

## Hosted lifecycle ownership

The authoritative hosted lifecycle and smoke process lives in the crawlback
repository's [`docs/ops/hosted-mcp-smoke.md`](https://github.com/pucilpet/crawlback/blob/master/docs/ops/hosted-mcp-smoke.md).
That runbook records the externally owned container boundary, release gates,
redaction rules, and operator-approved functional verification. Follow it in
full for any hosted release; this repository intentionally does not prescribe
an ad hoc `docker rm -f` or replacement-container shortcut.

The hosted server remains a standalone container on the `crawlback_default`
Docker network, fronted by the existing crawlback nginx + Cloudflare. It is
intentionally not in the crawlback compose file.

nginx route (in crawlback `nginx/nginx.conf`):

```nginx
upstream mcp { server crawlgraph-mcp:8080; }
# inside the server block:
location /mcp {
    proxy_pass http://mcp;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;   # gap jobs poll up to ~90s
    proxy_buffering off;
}
```

After editing nginx.conf: `docker exec crawlback-nginx nginx -t` then
`docker compose up -d --force-recreate nginx` (a plain reload can miss the
mounted-file change — recreate is reliable).

## Release note

Build and review the package locally first. Publishing or deploying a reviewed
commit requires explicit operator authorization and must use the crawlback
runbook's lifecycle record and smoke checks. Do not infer that a local package
version is live at the hosted endpoint.

## Health

`GET https://crawlgraph.com/mcp` → 405 (stateless; POST only).
Container-internal liveness: `GET /healthz` on :8080.

## Connecting (client side)

```
URL:   https://crawlgraph.com/mcp
Header: Authorization: Bearer cg_live_<your-key>
```
No install needed — this is the zero-install alternative to `npx -y crawlgraph-mcp`.
