FROM alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8 AS aws-cli

ARG TARGETARCH
ARG AWS_CLI_VERSION=2.38.1
RUN case "$TARGETARCH" in \
      amd64) AWS_ARCH=x86_64; AWS_SHA256=b11ed416d91f4251da363a17706938eeaf0e520745754c104c0c1890dd8363c7 ;; \
      arm64) AWS_ARCH=aarch64; AWS_SHA256=91360c0adb2ae508334ff657dce4787b598b443a11cf3dc58e08b74f12e16009 ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac \
  && wget -q "https://awscli.amazonaws.com/awscli-exe-linux-${AWS_ARCH}-${AWS_CLI_VERSION}.zip" -O /tmp/awscliv2.zip \
  && echo "$AWS_SHA256  /tmp/awscliv2.zip" | sha256sum -c \
  && unzip -q /tmp/awscliv2.zip -d /tmp \
  && /tmp/aws/install \
  && rm -rf /tmp/aws /tmp/awscliv2.zip

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
COPY --from=aws-cli /usr/local/aws-cli /usr/local/aws-cli
RUN ln -s /usr/local/aws-cli/v2/current/bin/aws /usr/local/bin/aws

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY shared ./shared
COPY packages ./packages
COPY servers/governed-cli/src ./servers/governed-cli/src
COPY servers/remote-shell ./servers/remote-shell
RUN chown -R 10001:10001 /app

ENV NODE_ENV=production
ENV PORT=8080
ENV HOME=/tmp
ENV REMOTE_SHELL_AWS_CLI_PATH=/usr/local/bin/aws

USER 10001:10001

CMD ["bun", "run", "servers/remote-shell/src/main.ts"]
