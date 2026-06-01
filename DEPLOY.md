# Hosted endpoint deployment

The hosted remote MCP server runs at **https://crawlgraph.com/mcp** (Streamable
HTTP transport, stateless, multi-tenant — each request carries the caller's own
`Authorization: Bearer cg_live_…` key).

## How it's deployed (prod: backlinkrobot / crawlback stack)

It runs as a standalone container on the `crawlback_default` docker network,
fronted by the existing crawlback nginx + Cloudflare. It is intentionally NOT in
the crawlback compose file (decoupled from the main stack).

```bash
# on the prod host
cd /root/crawlgraph-mcp && git pull
docker build -t crawlgraph-mcp:latest .
docker rm -f crawlgraph-mcp 2>/dev/null || true
docker run -d --name crawlgraph-mcp --network crawlback_default \
  --restart unless-stopped -e PORT=8080 \
  --entrypoint node crawlgraph-mcp:latest dist/http.js
```

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

## Redeploy after a code change

```bash
cd /root/crawlgraph-mcp && git pull
docker build -t crawlgraph-mcp:latest .
docker rm -f crawlgraph-mcp && docker run -d --name crawlgraph-mcp \
  --network crawlback_default --restart unless-stopped -e PORT=8080 \
  --entrypoint node crawlgraph-mcp:latest dist/http.js
```

## Health

`GET https://crawlgraph.com/mcp` → 405 (stateless; POST only).
Container-internal liveness: `GET /healthz` on :8080.

## Connecting (client side)

```
URL:   https://crawlgraph.com/mcp
Header: Authorization: Bearer cg_live_<your-key>
```
No install needed — this is the zero-install alternative to `npx -y crawlgraph-mcp`.
