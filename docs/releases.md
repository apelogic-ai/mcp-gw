# Releases

MCP Gateway releases are environment-neutral product artifacts that an external GitOps repository
can consume directly. Organization-specific domains, issuers, Secret names, enabled adapters,
sizing, and scheduling remain in a private values overlay; deployment teams do not patch or fork the
public chart.

## Versioning

Use SemVer. Before 1.0, a minor release may change the deployment contract and must call out every
required operator action in its upgrade notes. At and after 1.0, those changes require a major
release:

- `MAJOR`: at and after 1.0, breaking changes to public deployment shape, MCP endpoint behavior,
  environment variable names, policy semantics, or documented admin workflows.
- `MINOR`: backward-compatible features, or explicitly documented deployment-contract changes while
  the project remains below 1.0.
- `PATCH`: bug fixes, documentation fixes, test improvements, and non-breaking deployment-template
  corrections.

The current public release line is `v0.5.0`.

### 0.5.0 upgrade notes

- Kubernetes 1.32 or newer is required.
- An enabled AgentGateway must set
  `agentgateway.mcpAuthentication.resourceMetadata.resource` and configure at least one enabled
  backend. Installations that previously rendered an empty gateway must choose a provider or an
  external backend before upgrading.

## Release Artifacts

Each tagged release provides:

- an annotated Git tag named `vX.Y.Z`;
- an OCI Helm chart at `oci://ghcr.io/apelogic-ai/charts/mcp-gateway`;
- immutable, digest-addressable agentgateway, Google Workspace wrapper, and GitHub wrapper images;
- an SPDX JSON SBOM and JSON vulnerability report for every first-party image;
- GitHub build provenance attestations for image and chart digests;
- a generated release handoff recording exact coordinates, digests, ports, probes, and Secret keys;
- a GitHub Release containing the handoff and supply-chain evidence.

Repositories that require a private registry can opt into release promotion through GitHub
repository variables. Set `ECR_PROMOTION_ENABLED`, `AWS_RELEASE_ROLE_ARN`, `AWS_REGION`,
`ECR_REGISTRY`, `MCP_GW_ECR_AGENTGATEWAY_REPOSITORY`,
`MCP_GW_ECR_GOOGLE_WORKSPACE_REPOSITORY`, `MCP_GW_ECR_GITHUB_WRAPPER_REPOSITORY`, and
`MCP_GW_ECR_CHART_REPOSITORY`. The release workflow copies the approved first-party image and chart
manifests to those OCI repositories, verifies that every destination digest matches the public
release, and uploads a private handoff artifact containing SBOMs, vulnerability reports, and
immutable coordinates. Public provenance remains attached only to the GHCR source artifacts;
private registry copies are not separately attested or signed because that would publish private
coordinates to a public transparency log. Entries created by older releases are append-only and
cannot be deleted. The legacy
`MCP_GW_ECR_IMAGE_REPOSITORY` variable remains a fallback for the agentgateway repository. The
third-party official GitHub MCP image is not promoted; deployment GitOps owns its reviewed mirror.
Registry locations and IAM role identifiers are deployment configuration and are never committed
to this repository.

Release tags are convenient selectors. Production overlays should pin the image digests recorded in
the release handoff, or mirror those exact digests into an approved private registry. The release
workflow also verifies that the chart and first-party images can be fetched anonymously before it
creates the GitHub Release. A critical vulnerability in any first-party artifact blocks release.

The release-owned `mcp-gw-agentgateway` image is built from the exact compatible source revision
declared once in [`.release/agentgateway-source.json`](../.release/agentgateway-source.json). Pull
request CI and tagged releases build that same source and record the fork source URL and revision in
the image metadata. See [AgentGateway compatibility source](agentgateway-source.md) for the patch
set and upstream sync procedure.

## Cutting A Release

1. Start from a clean `main`.
2. Update `package.json` to the target SemVer version.
3. Move relevant `CHANGELOG.md` entries from `Unreleased` to the target version.
4. Run local gates:

   ```bash
   bun install
   bun run ci
   bun run deploy:check
   bun run release:check
   ```

5. Commit the version and changelog update.
6. Create and push an annotated tag:

   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

7. Wait for the `Release` workflow to pass. It validates the product, runs Kubernetes smoke tests,
   publishes and attests the OCI artifacts, verifies anonymous access, and creates the GitHub
   Release.

## GitOps Consumption

External GitOps repositories should reference the OCI Helm chart version and maintain a private
values overlay. Pin every image by digest using the release handoff. Mirroring is supported through
the image repository and digest overrides, but source patches are not required. See
[release-handoff.md](release-handoff.md) for the stable operator contract.
