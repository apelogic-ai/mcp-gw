FROM alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8 AS kubectl

ARG TARGETARCH
ARG KUBECTL_VERSION=v1.37.1
RUN case "$TARGETARCH" in \
      amd64) KUBECTL_SHA256=65691ff77eb6fa44c908b77a1082c9f092c3b9733b5cefabec0d1104890e21a8 ;; \
      arm64) KUBECTL_SHA256=ff749f4b78d9c4f1ec87307df9b50119ed819e2094aa9810cb9acffc3286c8c7 ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac \
  && wget -q "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl" -O /usr/local/bin/kubectl \
  && echo "$KUBECTL_SHA256  /usr/local/bin/kubectl" | sha256sum -c \
  && chmod 0755 /usr/local/bin/kubectl

FROM alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8 AS ca-certificates

FROM oven/bun:1.2.21@sha256:5a2011bf09364b9af658ac1e66f60d08092f4291aeefbff448d58b027734fdd0 AS bun

FROM ubuntu:24.04@sha256:008173c23f95b170204355c12626cb5a965d779a7e1283b09e9cffbb1bf33ca3

COPY --from=ca-certificates /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=kubectl /usr/local/bin/kubectl /usr/local/bin/kubectl

RUN groupadd --gid 10001 mcp-gateway \
  && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /tmp --shell /usr/sbin/nologin mcp-gateway

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY shared ./shared
COPY packages ./packages
COPY servers/governed-cli ./servers/governed-cli
RUN chown -R 10001:10001 /app

ENV NODE_ENV=production
ENV PORT=8080
ENV HOME=/tmp
ENV GOVERNED_CLI_PACK_PATH=/app/servers/governed-cli/packs/kubectl/pack.yaml

USER 10001:10001

CMD ["bun", "run", "servers/governed-cli/src/main.ts"]
