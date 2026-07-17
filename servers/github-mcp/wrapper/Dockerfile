FROM oven/bun:1.2.21 AS bun

FROM ubuntu:24.04

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates nodejs \
  && rm -rf /var/lib/apt/lists/*

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

COPY package.json bun.lock tsconfig.json ./
COPY src ./src
COPY shared ./shared
COPY servers ./servers

RUN bun install --frozen-lockfile

ENV NODE_ENV=production
ENV PORT=8080
ENV GITHUB_MCP_UPSTREAM_URL=http://github-mcp:8082/mcp

CMD ["bun", "run", "servers/github-mcp/wrapper/src/main.ts"]
