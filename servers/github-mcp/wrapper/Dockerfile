FROM oven/bun:1.2.21 AS bun

FROM ubuntu:24.04

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates nodejs \
  && groupadd --gid 10001 mcp-gateway \
  && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /tmp --shell /usr/sbin/nologin mcp-gateway \
  && rm -rf /var/lib/apt/lists/*

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

COPY package.json bun.lock tsconfig.json ./
COPY src ./src
COPY shared ./shared
COPY servers ./servers

RUN bun install --frozen-lockfile
RUN chown -R 10001:10001 /app

ENV NODE_ENV=production
ENV PORT=8080
ENV GITHUB_MCP_UPSTREAM_URL=http://github-mcp:8082/mcp
ENV HOME=/tmp

USER 10001:10001

CMD ["bun", "run", "servers/github-mcp/wrapper/src/main.ts"]
