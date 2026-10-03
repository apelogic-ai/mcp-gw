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

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src
COPY shared ./shared
COPY packages ./packages
COPY servers/generic-wrapper ./servers/generic-wrapper

RUN chown -R 10001:10001 /app

ENV NODE_ENV=production
ENV PORT=8080
ENV HOME=/tmp

USER 10001:10001

CMD ["bun", "run", "servers/generic-wrapper/src/main.ts"]
