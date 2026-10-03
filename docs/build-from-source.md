# Build From Source And Verify Release Artifacts

This guide covers the artifacts published by an MCP-GW release and the separately maintained
GitHub MCP Server image that the release mirrors. Run the commands from the repository root at the
tag you intend to reproduce.

## Prerequisites

- Git and `jq`;
- Bun `1.2.21`;
- Docker with Buildx;
- Helm 3;
- ORAS `1.3.3` or newer; and
- GitHub CLI for release downloads and GitHub Attestations verification.

Clone an exact release rather than a moving branch:

```bash
TAG=vX.Y.Z
git clone https://github.com/apelogic-ai/mcp-gw.git
cd mcp-gw
git checkout --detach "$TAG"

bun install --frozen-lockfile
bun run ci
bun run deploy:check
bun run release:check
```

The wrapper Dockerfiles pin their Bun, Ubuntu, and CA-bootstrap bases by digest, install only
production root dependencies, and use a dated Ubuntu snapshot plus direct package versions so the
complete apt dependency closure remains available and fixed. The bootstrap bundle permits the
first snapshot TLS request before Ubuntu's `ca-certificates` package is installed. Arm64 sources
are normalized from the ports archive to the snapshot-backed Ubuntu archive, and the build fails
unless `apt-cache policy` proves that the selected snapshot supplied the package index. The Google
Workspace image also validates an architecture-specific SHA-256 checksum before installing the
pinned `gws` binary. AgentGateway and the third-party GitHub MCP Server have their own immutable
source records under `.release/`.

## Build The First-Party Images

Choose one local platform. Docker cannot `--load` a multi-platform image into the local engine; use
a registry or OCI-layout output when producing a multi-platform manifest.

```bash
VERSION="$(jq -r .version package.json)"
PLATFORM=linux/amd64 # use linux/arm64 on an ARM builder

docker buildx build --platform "$PLATFORM" --load \
  --file servers/google-workspace/wrapper/Dockerfile \
  --tag "mcp-gw-google-workspace:$VERSION" .

docker buildx build --platform "$PLATFORM" --load \
  --file servers/github-mcp/wrapper/Dockerfile \
  --tag "mcp-gw-github-wrapper:$VERSION" .

docker buildx build --platform "$PLATFORM" --load \
  --file servers/generic-wrapper/Dockerfile \
  --tag "mcp-gw-generic-wrapper:$VERSION" .
```

The release-owned AgentGateway image is built from the compatibility fork and exact commit in
`.release/agentgateway-source.json`, not from an independently chosen upstream tag:

```bash
AGENTGATEWAY_REPOSITORY="$(jq -r .repository .release/agentgateway-source.json)"
AGENTGATEWAY_REF="$(jq -r .ref .release/agentgateway-source.json)"

bun scripts/resolve-agentgateway-source.ts
mkdir -p .build
git clone "https://github.com/$AGENTGATEWAY_REPOSITORY.git" .build/agentgateway
git -C .build/agentgateway checkout --detach "$AGENTGATEWAY_REF"

docker buildx build --platform "$PLATFORM" --load \
  --build-arg "VERSION=$VERSION" \
  --build-arg "GIT_REVISION=$AGENTGATEWAY_REF" \
  --label "org.opencontainers.image.source=https://github.com/$AGENTGATEWAY_REPOSITORY" \
  --label "org.opencontainers.image.revision=$AGENTGATEWAY_REF" \
  --label "org.opencontainers.image.version=$VERSION" \
  --tag "mcp-gw-agentgateway:$VERSION" .build/agentgateway
```

## Mirror The Reviewed Third-Party Image

MCP-GW does not rebuild GitHub's official MCP Server. It copies the reviewed upstream manifest and
its referrers by digest, then requires the destination to resolve to that same digest. Choose a
destination registry for a local reproduction:

```bash
bun scripts/resolve-github-mcp-source.ts

GITHUB_MCP_SOURCE="$(jq -r '.sourceRepository + "@" + .sourceDigest' .release/github-mcp-source.json)"
GITHUB_MCP_SOURCE_DIGEST="$(jq -r .sourceDigest .release/github-mcp-source.json)"
GITHUB_MCP_SOURCE_TAG="$(jq -r .sourceTag .release/github-mcp-source.json)"
GITHUB_MCP_MIRROR=registry.example.com/mcp-gw-github-mcp-server

oras cp --recursive "$GITHUB_MCP_SOURCE" "$GITHUB_MCP_MIRROR:$GITHUB_MCP_SOURCE_TAG"
test "$(oras resolve "$GITHUB_MCP_MIRROR:$GITHUB_MCP_SOURCE_TAG")" = \
  "$GITHUB_MCP_SOURCE_DIGEST"
```

The optional `dbMcp` adapter is not a published release artifact. Its image repository remains an
operator-supplied integration point, so it is outside this release build and verification list.

## Package The Helm Chart

```bash
mkdir -p dist
helm lint deploy/k8s/chart
helm package deploy/k8s/chart \
  --version "$VERSION" \
  --app-version "$VERSION" \
  --destination dist
```

The tagged release workflow additionally replaces the chart's Artifact Hub image annotations with
the exact published digests before packaging.

## Verify Published Release Artifacts

MCP-GW first-party images and its OCI chart use **GitHub build-provenance attestations**. They do not
publish standalone Cosign signature objects. Do not use `cosign verify` for these artifacts: it asks
the registry for a different signature layout and can return a confusing `404` even when the GitHub
attestation is present and valid.

The generated `github-governance-catalog.json` release asset uses the same workflow-bound GitHub
Attestation model. It is generated from the pinned wrapper catalog rather than built into an OCI
image.

Download the digest files from the GitHub Release, then verify each first-party OCI subject with
GitHub CLI:

```bash
TAG=vX.Y.Z
VERSION="${TAG#v}"
ARTIFACTS="$(mktemp -d)"
SIGNER="https://github.com/apelogic-ai/mcp-gw/.github/workflows/release.yml@refs/tags/$TAG"

gh release download "$TAG" \
  --repo apelogic-ai/mcp-gw \
  --pattern '*.digest' \
  --pattern 'github-governance-catalog.json' \
  --dir "$ARTIFACTS"

gh attestation verify \
  "oci://ghcr.io/apelogic-ai/mcp-gw-agentgateway@$(cat "$ARTIFACTS/agentgateway.digest")" \
  --repo apelogic-ai/mcp-gw --cert-identity "$SIGNER"

gh attestation verify \
  "oci://ghcr.io/apelogic-ai/mcp-gw-google-workspace@$(cat "$ARTIFACTS/google-workspace.digest")" \
  --repo apelogic-ai/mcp-gw --cert-identity "$SIGNER"

gh attestation verify \
  "oci://ghcr.io/apelogic-ai/mcp-gw-github-wrapper@$(cat "$ARTIFACTS/github-wrapper.digest")" \
  --repo apelogic-ai/mcp-gw --cert-identity "$SIGNER"

gh attestation verify \
  "oci://ghcr.io/apelogic-ai/mcp-gw-generic-wrapper@$(cat "$ARTIFACTS/generic-wrapper.digest")" \
  --repo apelogic-ai/mcp-gw --cert-identity "$SIGNER"

gh attestation verify \
  "oci://ghcr.io/apelogic-ai/charts/mcp-gateway@$(cat "$ARTIFACTS/helm-chart.digest")" \
  --repo apelogic-ai/mcp-gw --cert-identity "$SIGNER"

gh attestation verify \
  "$ARTIFACTS/github-governance-catalog.json" \
  --repo apelogic-ai/mcp-gw --cert-identity "$SIGNER"
```

The mirrored GitHub MCP Server does not have an MCP-GW build-provenance attestation because this
repository did not build it. Verify digest equality between the reviewed source record, the release
digest file, and both registry coordinates:

```bash
EXPECTED="$(jq -r .sourceDigest .release/github-mcp-source.json)"
UPSTREAM="$(jq -r .sourceRepository .release/github-mcp-source.json)"
GITHUB_MCP_SOURCE_TAG="$(jq -r .sourceTag .release/github-mcp-source.json)"
MIRROR=ghcr.io/apelogic-ai/mcp-gw-github-mcp-server
RELEASED="$(cat "$ARTIFACTS/github-mcp-server.digest")"

cosign verify \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity "https://github.com/github/github-mcp-server/.github/workflows/docker-publish.yml@refs/tags/$GITHUB_MCP_SOURCE_TAG" \
  "$UPSTREAM@$EXPECTED"

test "$RELEASED" = "$EXPECTED"
test "$(oras resolve "$UPSTREAM@$EXPECTED")" = "$EXPECTED"
test "$(oras resolve "$MIRROR@$RELEASED")" = "$EXPECTED"
```

The Cosign signature belongs to GitHub's upstream coordinate. The digest-preserving MCP-GW mirror
does not copy Cosign's legacy signature tag, so verify the upstream signature first and then prove
that the upstream and mirror resolve to the same reviewed digest.

Finally, prove the recorded artifacts are anonymously fetchable:

```bash
docker buildx imagetools inspect \
  "ghcr.io/apelogic-ai/mcp-gw-agentgateway@$(cat "$ARTIFACTS/agentgateway.digest")"
docker buildx imagetools inspect \
  "ghcr.io/apelogic-ai/mcp-gw-google-workspace@$(cat "$ARTIFACTS/google-workspace.digest")"
docker buildx imagetools inspect \
  "ghcr.io/apelogic-ai/mcp-gw-github-wrapper@$(cat "$ARTIFACTS/github-wrapper.digest")"
docker buildx imagetools inspect \
  "ghcr.io/apelogic-ai/mcp-gw-generic-wrapper@$(cat "$ARTIFACTS/generic-wrapper.digest")"
docker buildx imagetools inspect \
  "ghcr.io/apelogic-ai/mcp-gw-github-mcp-server@$(cat "$ARTIFACTS/github-mcp-server.digest")"
helm pull oci://ghcr.io/apelogic-ai/charts/mcp-gateway \
  --version "$VERSION" \
  --destination "$ARTIFACTS"
```

The release also attaches SBOM and vulnerability-report files for first-party artifacts. Those are
evidence about the attested OCI subjects; they are not replacement signatures for the subjects.
Local BuildKit metadata and timestamps can make independently built manifest digests differ, so use
the attestation and release digest—not byte-for-byte equality with a local build—to verify an
official release.
