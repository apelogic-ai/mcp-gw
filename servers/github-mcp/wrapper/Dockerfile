FROM oven/bun:1.2.21@sha256:5a2011bf09364b9af658ac1e66f60d08092f4291aeefbff448d58b027734fdd0 AS bun

FROM ubuntu:24.04@sha256:008173c23f95b170204355c12626cb5a965d779a7e1283b09e9cffbb1bf33ca3

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates=20260601~24.04.1 \
    nodejs=18.19.1+dfsg-6ubuntu5 \
  && groupadd --gid 10001 mcp-gateway \
  && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /tmp --shell /usr/sbin/nologin mcp-gateway \
  && rm -rf /var/lib/apt/lists/*

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src
COPY shared ./shared
COPY servers ./servers

RUN chown -R 10001:10001 /app

ENV NODE_ENV=production
ENV PORT=8080
ENV GITHUB_MCP_UPSTREAM_URL=http://github-mcp:8082/mcp
ENV HOME=/tmp

USER 10001:10001

CMD ["bun", "run", "servers/github-mcp/wrapper/src/main.ts"]
