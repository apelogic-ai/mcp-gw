# Releases

MCP Gateway releases are environment-neutral product artifacts that an external GitOps repository
can consume directly. Organization-specific domains, issuers, Secret names, enabled adapters,
sizing, and scheduling remain in a private values overlay; deployment teams do not patch or fork the
public chart.

## Versioning

Use SemVer:

- `MAJOR`: breaking changes to public deployment shape, MCP endpoint behavior, environment variable
  names, policy semantics, or documented admin workflows.
- `MINOR`: backward-compatible features such as new backend registry fields, new Google Workspace
  tools, new deployment examples, or new optional policy integrations.
- `PATCH`: bug fixes, documentation fixes, test improvements, and non-breaking deployment-template
  corrections.

The current public release line is `v0.2.5`.

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
repository variables. The release workflow copies the approved agentgateway and chart manifests to
the configured OCI repositories, verifies that the destination digests match the public release,
and uploads a private handoff artifact containing signatures, certificates, provenance, SBOMs,
vulnerability reports, and immutable coordinates. Registry locations and IAM role identifiers are
deployment configuration and are never committed to this repository.

Release tags are convenient selectors. Production overlays should pin the image digests recorded in
the release handoff, or mirror those exact digests into an approved private registry. The release
workflow also verifies that the chart and first-party images can be fetched anonymously before it
creates the GitHub Release.

The release-owned `mcp-gw-agentgateway` image is built from the exact compatible source revision
declared in the release workflow. It contains the MCP multi-provider authentication and routing
behavior expected by this chart.

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
