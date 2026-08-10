# Changelog

All notable project changes are tracked here.

This project uses SemVer for source, deployment templates, and public operational contracts. The
GitHub release notes for each tag are generated from merged pull requests; this file records the
human-maintained compatibility summary.

## [Unreleased]

## [0.2.9] - 2026-08-10

### Fixed

- Support operator-owned PostgreSQL CA bundles across OAuth migrations and provider wrappers while
  preserving strict certificate and hostname verification.

## [0.2.8] - 2026-08-09

### Security

- Override the official GitHub MCP server image's root OCI user with an explicit non-root UID and
  GID, and verify the workload starts under that security context in Kubernetes CI.
- Bind GitHub OAuth callbacks to the authenticated HOP-1 corporate email, reject mismatches without
  persisting credentials, attempt narrow revocation of mismatched tokens, consume SQL-backed OAuth
  state atomically, and fail wrapper startup when required GitHub OAuth configuration is absent.
- Require the shared policy decision to authorize Google and GitHub OAuth initiation helpers before
  either wrapper can persist single-use state or return a provider authorization URL.

## [0.2.7] - 2026-08-07

### Security

- Reject ambiguous or malformed HOP-1 issuer profile sets before wrappers start, including
  duplicate names, issuer URLs, audiences, and algorithms.
- Expanded the local authorization-server fixture to cover discovery, JWKS retrieval, token
  acquisition, not-before enforcement, and algorithm allowlist failures.
- Require an expiration claim in HOP-1 tokens at both agentgateway and wrapper enforcement layers.
- Verify keyless signatures for every promoted private-registry image and chart against the exact
  release workflow identity immediately after signing.

### Added

- Added an opt-in Google Workspace and GitHub provider bundle with versioned, concurrency-safe
  OAuth database migrations and TLS PostgreSQL support.
- Added full-bundle integration coverage for provider consent, safe backend calls, and credential
  isolation, plus Kubernetes runtime coverage for the migration job and both wrappers.
- Extended private-registry promotion and release evidence to the Google Workspace and GitHub
  wrappers.

### Fixed

- Run first-party wrappers and OAuth migrations as a numeric non-root user compatible with the
  chart security context.
- Require production profiles to configure exactly one enabled `google-workspace` target and one
  enabled `github-mcp` target.
- Gate release publication on the complete provider-bundle integration test.

### Upgrade Notes

- Provider workloads remain disabled by default. Deployments enabling the production provider
  profile must configure both required backend targets and provide the documented OAuth secrets.

## [0.2.6] - 2026-08-05

### Security

- Added a required, deployment-owned JWT algorithm allowlist to every configured HOP-1 issuer
  profile and enforced it in agentgateway and wrapper validation paths.
- Added optional authenticated token introspection with fail-closed handling for unavailable
  services, invalid credentials, and inactive tokens.
- Enforced exact issuer and audience matching alongside JWKS signature validation and algorithm
  restrictions.

### Changed

- Rendered generic issuer introspection and Secret-backed credentials into the active agentgateway
  configuration while keeping public chart defaults environment-neutral.
- Pinned the release-owned agentgateway build to the merged issuer-enforcement implementation.

### Upgrade Notes

- Private overlays that configure HOP-1 issuers must add a non-empty
  `hop1.issuers[].allowedAlgorithms` list before upgrading. Profiles that enable introspection must
  also reference an existing Kubernetes Secret containing the introspection credential.

## [0.2.5] - 2026-08-04

### Fixed

- Normalized one-issuer Helm values to agentgateway's failure-isolated provider configuration so
  an unavailable remote JWKS endpoint fails affected requests closed without blocking gateway
  startup or readiness.

## [0.2.4] - 2026-08-04

- Added an optional, environment-neutral release promotion job that copies the approved
  agentgateway image and OCI Helm chart into configured private ECR repositories without changing
  their digests.
- Added keyless signatures, ECR provenance bundles, chart SBOM and vulnerability evidence, and a
  private registry handoff artifact containing immutable coordinates and the release commit.
- Expanded authentication release coverage for missing, expired, wrong-issuer, wrong-audience, and
  invalid-signature tokens while preserving unauthenticated protected-resource metadata.
- Verified that an unavailable issuer JWKS endpoint fails affected requests closed without making
  the gateway deployment unready.

## [0.2.3] - 2026-08-03

- Fixed OCI Helm chart provenance publishing by providing GHCR credentials through Docker's
  credential store as required by the GitHub attestation action.
- Hardened the Kubernetes issuer-isolation smoke test to extract a labeled HTTP status instead of
  comparing status output mixed with `kubectl` lifecycle messages.
- Superseded the incomplete `v0.2.2` publication, which did not produce chart provenance, pass the
  anonymous artifact gate, or create a GitHub Release.

## [0.2.2] - 2026-08-03

- Published an environment-neutral Kubernetes release contract with a JSON values schema, generic
  issuer and backend configuration, existing Secret references, and private-overlay examples for
  Flux and Argo CD.
- Added image repository, tag, and digest overrides plus configurable ingress, service accounts,
  replicas, resources, autoscaling, disruption budgets, scheduling, and health probes.
- Added immutable OCI release artifacts with per-image SBOMs, vulnerability reports, provenance,
  digest handoff metadata, and anonymous GHCR-access verification.
- Isolated unavailable JWKS providers so requests for an affected issuer fail closed without making
  the gateway unready for healthy issuers; failed JWKS resources continue retrying.
- Added Kubernetes integration smoke coverage for issuer isolation and corrected agentgateway to
  load its generated configuration with the file-based CLI option.
- Removed environment-owned AWS, Ansible, host, and deployment configuration from the public
  product repository. Private infrastructure and environment policy now remain in external
  infrastructure and GitOps repositories.

## [0.2.1] - 2026-07-29

- Separated gateway authentication from downstream provider consent so Google Workspace and GitHub
  use the same explicit per-provider OAuth helper flow.
- Fixed generated Google Workspace tools to accept structured request bodies and improved upload
  handling and guidance.
- Added configured HOP-1 issuer introspection and exposed verified identity claims to YAML tool
  policies.
- Fixed HOP-1 protected-resource metadata to advertise the configured identity scopes, including
  consistent Docker Compose, Ansible, Helm, and local integration behavior.
- Added Helm rendering for front-door MCP authentication and aligned Helm chart release metadata
  with the source release.
- No data migration is required. Existing clients only need to reconnect if they cached invalid
  protected-resource metadata from an affected deployment.

## [0.2.0] - 2026-07-18

- Added optional official GitHub MCP backend bundling through the MCP-GW backend registry.
- Added GitHub OAuth connection routes, per-user GitHub token storage, OAuth status/start helper
  tools, and compatibility aliases for client-owned GitHub tool surfaces.
- Added exact-name shared backend federation support for agentgateway with `prefixMode: never`,
  allowing multiple MCP backends to share one `/mcp` route without forced prefixes.
- Added streamable HTTP/SSE tool-list merging for the GitHub wrapper so local OAuth helper tools
  remain advertised after GitHub is connected.
- Added generic provider connection flow documentation for clients that integrate with MCP-GW
  without a bundled application control plane.
- Pinned the required project-maintained agentgateway build containing multi-provider MCP
  authentication and exact-name routing support.
- Improved DEV, Compose, Kubernetes, and local smoke-test coverage for optional GitHub and
  federated backend deployments.

## [0.1.0] - 2026-07-08

- Initial public OSS release foundation for MCP Gateway.
- Google Workspace MCP wrapper with per-user Google OAuth token storage.
- Agentgateway front door for remote MCP authentication and protected-resource metadata.
- Docker Compose, AWS DEV Compose host, Terraform, Ansible, Helm, Flux, and Argo deployment
  templates.
- Generated Google Workspace `gws_*` tool catalog with curated default service families.
- Optional Google Workspace YAML policy file and external OPA policy integration.

[Unreleased]: https://github.com/apelogic-ai/mcp-gw/compare/v0.2.9...HEAD
[0.2.9]: https://github.com/apelogic-ai/mcp-gw/compare/v0.2.8...v0.2.9
[0.2.8]: https://github.com/apelogic-ai/mcp-gw/compare/v0.2.7...v0.2.8
[0.2.7]: https://github.com/apelogic-ai/mcp-gw/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/apelogic-ai/mcp-gw/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/apelogic-ai/mcp-gw/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/apelogic-ai/mcp-gw/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/apelogic-ai/mcp-gw/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/apelogic-ai/mcp-gw/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/apelogic-ai/mcp-gw/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/apelogic-ai/mcp-gw/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/apelogic-ai/mcp-gw/releases/tag/v0.1.0
