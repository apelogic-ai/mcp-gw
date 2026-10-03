FROM alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8 AS ca-certificates

FROM oven/bun:1.2.21@sha256:5a2011bf09364b9af658ac1e66f60d08092f4291aeefbff448d58b027734fdd0 AS bun

FROM ubuntu:24.04@sha256:008173c23f95b170204355c12626cb5a965d779a7e1283b09e9cffbb1bf33ca3

ARG TARGETARCH
ARG UBUNTU_SNAPSHOT=20260928T000000Z
COPY --from=ca-certificates /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN case "$TARGETARCH" in amd64|arm64) ;; *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; esac \
  && sed -i \
    -e "s#http://archive.ubuntu.com/ubuntu/#https://snapshot.ubuntu.com/ubuntu/$UBUNTU_SNAPSHOT/#g" \
    -e "s#http://security.ubuntu.com/ubuntu/#https://snapshot.ubuntu.com/ubuntu/$UBUNTU_SNAPSHOT/#g" \
    -e "s#http://ports.ubuntu.com/ubuntu-ports/#https://snapshot.ubuntu.com/ubuntu/$UBUNTU_SNAPSHOT/#g" \
    /etc/apt/sources.list.d/ubuntu.sources \
  && ! grep -Eq 'https?://(archive|security|ports)\.ubuntu\.com' /etc/apt/sources.list.d/ubuntu.sources \
  && apt-get update --error-on=any \
  && apt-cache policy ca-certificates | grep -F "https://snapshot.ubuntu.com/ubuntu/$UBUNTU_SNAPSHOT" \
  && apt-get install -y --no-install-recommends \
    ca-certificates=20260601~24.04.1 \
  && groupadd --gid 10001 mcp-gateway \
  && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /tmp --shell /usr/sbin/nologin mcp-gateway \
  && rm -rf /var/lib/apt/lists/*

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

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
COPY packages ./packages
COPY servers ./servers
RUN chown -R 10001:10001 /app

ENV NODE_ENV=production
ENV PORT=8080
ENV GWS_BINARY_PATH=/usr/local/bin/gws
ENV HOME=/tmp

USER 10001:10001

CMD ["bun", "run", "servers/google-workspace/wrapper/src/main.ts"]
