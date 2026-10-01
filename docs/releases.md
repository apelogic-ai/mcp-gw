# Releases

MCP Gateway releases are environment-neutral product artifacts that an external deployment system
can consume directly. Organization-specific domains, issuers, Secret names, enabled adapters,
sizing, and scheduling remain in a private values overlay; deployment teams do not patch or fork
the public chart.

## Versioning

Use SemVer. Before 1.0, a minor release may change the deployment contract and must call out every
required operator action in its upgrade notes. At and after 1.0, those changes require a major
release:

- `MAJOR`: at and after 1.0, breaking changes to public deployment shape, MCP endpoint behavior,
  environment variable names, policy semantics, or documented admin workflows.
- `MINOR`: backward-compatible features, or explicitly documented deployment-contract changes while
  the project remains below 1.0.
- `PATCH`: bug fixes, documentation fixes, test improvements, and non-breaking deployment-template
  corrections. Before 1.0, a narrowly scoped security hardening may also ship in a patch when its
  operator impact and opt-out are explicit in the upgrade notes.

The current public release line is `v0.5.5`.

### 0.5.5 upgrade notes

- Run the new forward-only `008_provider_account_identity.sql` migration before starting 0.5.5
  wrappers. The bundled Helm and Compose migration paths run it automatically, including for reused
  PostgreSQL volumes.
- Connection status remains byte-compatible version 1 by default. Send
  `Accept: application/vnd.apelogic.connection-status.v2+json` to canonical connection routes to
  request version 2, which exposes the immutable numeric GitHub user ID as `account.id`. Consumers
  must match on that field only; login, email, and display name remain mutable display metadata.
- Existing GitHub connections need no OAuth reconnect. Their first status read or refresh performs
  one `GET /user` lookup and persists the missing ID. A later authorization or refresh that resolves
  another numeric ID advances the credential generation and emits a bounded rebinding audit event.
- Legacy ID lookup is best-effort and single-flight per connection and replica. Provider failures
  leave status readable without `account.id` and are retried after a bounded delay.
- No provider reauthorization, Secret-format change, chart value rename, or new required value is
  introduced.

### 0.5.4 upgrade notes

- Use 0.5.4 instead of the unpublished 0.5.3 artifact set. The `v0.5.3` workflow stopped at its
  Kubernetes release gate before publishing images, the chart, or a GitHub Release. Version 0.5.4
  includes all 0.5.3 changes and the upgrade notes below.
- No additional database migration, Secret-format change, OAuth reconnect, provider
  reauthorization, chart value rename, or new required value is introduced beyond the documented
  0.5.3 changes.

### 0.5.3 upgrade notes

- Before upgrading, change or remove any existing Compose `.env` or Helm values override that sets
  `GWS_BINARY_PATH=/app/node_modules/.bin/gws`; the wrapper now refuses to start when the path is not
  an executable file. Set it to `GWS_BINARY_PATH=/usr/local/bin/gws` if an explicit override is
  required. The 0.5.2 workaround already uses that new default and may remain or be removed.
- No database migration, Secret-format change, OAuth reconnect, provider reauthorization, chart
  value rename, or new required value is introduced.
- AgentGateway now retries a remote JWKS source that is unavailable at startup and performs a
  rate-limited refresh for an unknown signing key, so issuer recovery and normal key rotation do
  not require an AgentGateway restart.
- GitHub OAuth requires the resolved HOP-1 `emailClaim` to case-insensitively match one of the
  user's verified GitHub email addresses. A mismatch consumes the one-time state, cleans up the
  issued credential, activates no connection, and reports `identity_mismatch`.
- Wrapper images resolve their apt dependency closure from a dated Ubuntu snapshot and no longer
  include the unused Node.js runtime. A digest-pinned CA bundle bootstraps snapshot TLS, the arm64
  source is normalized from the ports archive to the snapshot-backed Ubuntu archive, and image
  builds fail if APT does not resolve from the selected snapshot. First-party attestations are
  verified against the tagged release workflow; the third-party GitHub MCP mirror is verified from
  GitHub's upstream Cosign signature plus source/mirror digest equality.

### 0.5.2 upgrade notes

> **Known issue:** 0.5.2 sets an obsolete Google Workspace CLI path in the chart and Compose
> defaults. Set `googleWorkspace.env.GWS_BINARY_PATH=/usr/local/bin/gws` in Helm or
> `GWS_BINARY_PATH=/usr/local/bin/gws` in Compose, or remain on 0.5.1 until upgrading to 0.5.4.
> This does not require a database migration or OAuth reconnection.

- No database migration, Secret-format change, OAuth reconnect, provider reauthorization, chart
  value rename, or new required value is introduced.
- Existing GitHub MCP image overrides and the chart's upstream default remain valid. To use the new
  public release mirror, set `githubMcp.image.repository` and the exact mirror digest recorded in the
  release handoff.
- Wrapper entrypoints, ports, and runtime users are unchanged. Their bases, direct apt packages,
  and production dependencies are now pinned, and the Google Workspace CLI is installed during the
  image build. Apply the CLI-path workaround above because the 0.5.2 deployment defaults override
  the image's correct path.
- Verify MCP-GW-built images and the chart with GitHub Attestations. The third-party GitHub MCP
  Server mirror has no MCP-GW build attestation and is verified by source/mirror digest equality.

### 0.5.1 upgrade notes

- No database migration, Secret-format change, OAuth reconnect, or provider reauthorization is
  required.
- Workload resources remain opt-in (`resources: {}`), so this patch does not deep-merge new limits
  into existing partial overrides. Use the production examples as sizing guidance and supply a
  complete resource map appropriate to the cluster.
- Google Workspace and GitHub wrapper root filesystems are now read-only with a writable ephemeral
  `/tmp`. Mount an explicit writable volume for any added integration that writes elsewhere.
- Provider NetworkPolicies now admit only AgentGateway Pods with the same Helm release-instance
  label. Label an externally managed AgentGateway accordingly or add an environment-owned policy
  for that peer.
- CORS and backend failure behavior are configurable. Their defaults remain `*` and `failOpen`,
  respectively, for compatibility.

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
- a digest-preserving mirror of the reviewed official GitHub MCP Server image;
- an SPDX JSON SBOM and JSON vulnerability report for every first-party image;
- GitHub build provenance attestations for image and chart digests;
- a generated release handoff recording exact coordinates, digests, ports, probes, and Secret keys;
- a GitHub Release containing the handoff and supply-chain evidence.

Private-registry promotion is deliberately outside this public repository's release workflow. A
private deployment system may authenticate to GHCR and its destination registry, copy the approved
first-party image and chart manifests by digest, verify that destination digests match, and retain
private coordinates and handoff evidence only in its private control plane. Do not pass private
registry hosts, account identifiers, role ARNs, or derived repository names through this public
repository's Actions variables, logs, outputs, or workflow artifacts. Public provenance remains
attached only to the GHCR source artifacts. Older public transparency-log entries are append-only
and cannot be deleted; historical workflow logs and artifacts should be handled separately by a
repository administrator. The third-party official GitHub MCP image is mirrored without rebuilding
it. Its source and mirror must resolve to the same reviewed digest, and the mirror intentionally has
no MCP-GW build attestation. Deployment configuration may use the public release mirror or copy that
exact digest into an environment-owned registry.
Registry locations and IAM role identifiers are deployment configuration and are never committed
to this repository.

Release tags are convenient selectors. Production overlays should pin the image digests recorded in
the release handoff, or mirror those exact digests into an approved private registry. The release
workflow also verifies that the chart and first-party images can be fetched anonymously before it
creates the GitHub Release. A critical vulnerability in any first-party artifact blocks release.

See [Build from source and verify release artifacts](build-from-source.md) for exact local build and
mirror commands and for the distinction between MCP-GW's GitHub Attestations verification and the
digest-equality check used for the third-party mirror. Using a Cosign verification command against
an MCP-GW artifact checks the wrong evidence layout and can produce a misleading registry 404.

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
