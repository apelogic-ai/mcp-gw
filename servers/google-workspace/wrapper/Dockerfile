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

ARG TARGETARCH
RUN case "$TARGETARCH" in \
      amd64) \
        GWS_ARCHIVE="google-workspace-cli-x86_64-unknown-linux-gnu.tar.gz"; \
        GWS_SHA256="de78ecdbd2f1a84cca0063a7ecbc440240fc14b6ebccbb17f4646b792a8c5c1f" \
        ;; \
      arm64) \
        GWS_ARCHIVE="google-workspace-cli-aarch64-unknown-linux-gnu.tar.gz"; \
        GWS_SHA256="94490295d9580e1e88574e715a0a162991747d12d62f8c7b8dcc8268b6c1cea0" \
        ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac \
  && GWS_URL="https://github.com/googleworkspace/cli/releases/download/v0.22.5/$GWS_ARCHIVE" \
  && bun -e 'const response = await fetch(Bun.argv[1]); if (!response.ok) throw new Error(`${response.status} ${response.statusText}`); await Bun.write(Bun.argv[2], await response.arrayBuffer())' "$GWS_URL" /tmp/gws.tar.gz \
  && echo "$GWS_SHA256  /tmp/gws.tar.gz" | sha256sum --check --strict \
  && mkdir -p /tmp/gws /usr/share/licenses/google-workspace-cli \
  && tar -xzf /tmp/gws.tar.gz -C /tmp/gws \
  && install -m 0755 /tmp/gws/gws /usr/local/bin/gws \
  && install -m 0644 /tmp/gws/LICENSE /usr/share/licenses/google-workspace-cli/LICENSE \
  && rm -rf /tmp/gws /tmp/gws.tar.gz

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
ENV GWS_BINARY_PATH=/usr/local/bin/gws
ENV HOME=/tmp

USER 10001:10001

CMD ["bun", "run", "servers/google-workspace/wrapper/src/main.ts"]
