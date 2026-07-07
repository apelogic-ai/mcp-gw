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
RUN bun add @googleworkspace/cli@0.22.5

ENV NODE_ENV=production
ENV PORT=8080
ENV GWS_BINARY_PATH=/app/node_modules/.bin/gws

CMD ["bun", "run", "servers/google-workspace/wrapper/src/main.ts"]
