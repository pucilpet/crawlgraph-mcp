# Dockerfile for Glama introspection checks (and anyone who wants to run the
# stdio server in a container). Glama only needs the server to START and
# answer an MCP introspection (tools/list) request — which works without a
# real API key, since CRAWLGRAPH_API_KEY is only required when a tool is
# actually called, not to list tools.
FROM node:22-alpine

WORKDIR /app

# Copy sources first so the build has everything, then install with
# --ignore-scripts (the package's `prepare` hook also runs `tsc`; we run the
# build explicitly below instead of letting it fire mid-install).
COPY package.json package-lock.json* tsconfig.json ./
COPY src ./src
RUN npm install --ignore-scripts

# Build the stdio server.
RUN npm run build

# stdio MCP server. Glama / MCP clients talk to it over stdin/stdout.
ENTRYPOINT ["node", "dist/index.js"]
