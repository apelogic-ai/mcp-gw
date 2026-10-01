# Changelog

All notable project changes are tracked here.

This project uses SemVer for source, deployment templates, and public operational contracts. Each
GitHub Release publishes the curated deployment handoff and supply-chain evidence; this file
records the human-maintained compatibility summary.

## [Unreleased]

## [0.5.5] - 2026-09-30

### Added

- Expose the connected GitHub account's immutable numeric user ID in connection status contract
  version 2, retain the mutable login as display-only metadata, and lazily backfill existing
  connections without requiring OAuth reconnection.
- Record bounded audit events when a GitHub connection is backfilled or rebound to a different
  numeric account ID; account identifiers and logins are never included in those events.

### Changed

- Validate GitHub account identity through both `GET /user` and `/user/emails` when authorizing or
  rotating credentials. A different numeric account advances the durable credential generation
  before the replacement becomes active.

### Upgrade Notes

- Run the new forward-only `008_provider_account_identity.sql` migration before starting 0.5.5
  wrappers. The bundled Helm and Compose migration paths run it automatically.
- No OAuth reconnect, provider reauthorization, Secret-format change, chart value rename, or new
  required value is introduced. The first status read or refresh for a pre-0.5.5 GitHub connection
  performs one provider identity lookup and persists the missing account ID.
- Identity consumers must match GitHub connections on `account.id` only. `account.login`, email, and
  display name are mutable display metadata.
- Connection status remains byte-compatible version 1 by default for existing consumers. Request
  version 2 explicitly with `Accept: application/vnd.apelogic.connection-status.v2+json`; legacy
  OAuth status tools and routes retain their 0.5.4 response shape unless the HTTP route negotiates
  version 2.
- Legacy GitHub account-ID backfill is best-effort, single-flight per connection and replica, and
  retried with bounded backoff. A provider lookup failure leaves status available without `account.id`
  and emits only a bounded failure category.

## [0.5.4] - 2026-09-29

### Fixed

- Accept the Google Workspace CLI's informational disclaimer while still requiring the exact
  pinned version on the first output line of the Kubernetes release smoke. This repairs the
  publication gate that stopped the `v0.5.3` workflow before it published images, the chart, or a
  GitHub Release.

### Upgrade Notes

- Use 0.5.4 instead of the unpublished 0.5.3 artifact set. This release includes all 0.5.3 changes
  and its `GWS_BINARY_PATH` upgrade requirement.
- No additional database migration, Secret-format change, OAuth reconnect, provider
  reauthorization, chart value rename, or new required value is introduced beyond the documented
  0.5.3 changes.

## [0.5.3] - 2026-09-29

### Fixed

- Align every Helm, Compose, and integration default with the image's
  `GWS_BINARY_PATH=/usr/local/bin/gws`, reject a non-executable CLI path at wrapper startup, and run
  the real pinned CLI in the Kubernetes provider smoke.
- Retry remote AgentGateway JWKS sources that are unavailable during startup and perform a bounded
  on-demand refresh when a JWT uses an unknown key ID, allowing issuer recovery and signing-key
  rotation without restarting AgentGateway.

### Changed

- Document that GitHub consent requires the HOP-1 email claim to case-insensitively match a verified
  GitHub email and describe the fail-closed mismatch behavior.
- Pin wrapper apt resolution to a dated Ubuntu snapshot and remove the unused Node.js runtime.

### Security

- Bind GitHub Attestation verification to this repository's tagged release workflow, verify the
  official GitHub MCP Server's upstream Cosign signature before mirroring it, and document the
  upstream-signature plus digest-equality trust chain.

### Upgrade Notes

- Before upgrading, change or remove any existing Compose `.env` or Helm values override that sets
  `GWS_BINARY_PATH=/app/node_modules/.bin/gws`; the wrapper now refuses to start when the path is not
  an executable file. Set it to `GWS_BINARY_PATH=/usr/local/bin/gws` if an explicit override is
  required. The 0.5.2 workaround already uses that new default and may remain or be removed.
- AgentGateway now recovers a remote issuer JWKS that was unavailable at startup and refreshes an
  unknown signing key without a restart.
- No database migration, Secret-format change, OAuth reconnect, provider reauthorization, chart
  value rename, or new required value is introduced.
- Deployments using GitHub OAuth must ensure the configured HOP-1 `emailClaim` resolves to one of
  each user's verified GitHub email addresses; this documents and exposes the existing binding.

## [0.5.2] - 2026-09-28

### Known Issue

- The 0.5.2 chart and Compose defaults override the image with the obsolete
  `GWS_BINARY_PATH=/app/node_modules/.bin/gws`, so Google Workspace tool calls fail even though the
  Pod may report Ready. Override the value with `/usr/local/bin/gws`, or remain on 0.5.1 until
  upgrading to 0.5.4. No database migration or OAuth reconnection is required.

### Added

- Add a complete build-from-source guide for every published image and the Helm chart, including
  artifact-specific verification commands and the explicit boundary for the externally supplied
  `dbMcp` adapter.
- Mirror the reviewed official GitHub MCP Server image into the public MCP-GW release namespace
  without rebuilding it, record both immutable coordinates in the generated handoff, and require
  source/mirror digest equality before publication.

### Changed

- Pin wrapper Bun and Ubuntu base images by digest, direct apt packages by exact version, and
  production dependency installation to the checked-in lockfile.
- Install the architecture-specific Google Workspace CLI during the image build after validating
  its committed SHA-256 checksum, rather than mutating dependencies or downloading into a
  read-only runtime filesystem on first use.

### Security

- Document and test GitHub Attestations verification for MCP-GW-built OCI artifacts, while keeping
  the third-party mirror on a digest-equality trust path that does not claim MCP-GW build
  provenance.

### Upgrade Notes

- No database migration, Secret-format change, OAuth reconnect, provider reauthorization, chart
  value rename, or new required value is introduced.
- Existing GitHub MCP image overrides and the chart's upstream default remain valid. Operators may
  opt into the release mirror by setting `githubMcp.image.repository` and the mirror digest from the
  release handoff.
- Wrapper entrypoints, ports, and runtime users are unchanged. The Google Workspace CLI is present
  before startup, but the 0.5.2 chart and Compose defaults must be overridden to
  `GWS_BINARY_PATH=/usr/local/bin/gws` as described in the known issue above.
- Verify first-party release images and the chart with `gh attestation verify`, not `cosign verify`;
  verify the mirrored third-party image by matching its source and mirror digests.

## [0.5.1] - 2026-09-28

### Added

- Add configurable AgentGateway CORS allowlists and backend failure behavior, documented production
  resource-sizing examples, chart discovery metadata, operator notes, and validation for Google-only,
  GitHub-only, or combined production profiles.
- Define the compatible AgentGateway fork and immutable commit in one machine-readable source pin,
  use it in both pull-request CI and tagged releases, and document the five-patch compatibility set
  plus upstream sync procedure.

### Fixed

- Build and smoke-test the pinned AgentGateway source in CI instead of an older published image,
  and record the fork source URL and revision in binary and OCI metadata.
- Publish curated release notes without automatically injected contributor handles, use accurate
  architecture-index artifact names, and keep deployment handoffs platform-neutral.
- Reconcile release-version, external-issuer refresh-route, compatibility callback, and minimal
  Helm values documentation.

### Security

- Stop signing or publicly attesting optional private-registry mirrors; public provenance remains
  attached to the GHCR source artifacts without disclosing private registry coordinates.
- Replace personal chart and Artifact Hub contact metadata with organization-owned coordinates,
  run Google and GitHub wrappers with read-only root filesystems and writable ephemeral `/tmp`, and
  scope internal NetworkPolicy peers to the same Helm release.

### Upgrade Notes

- No database migration, Secret-format change, OAuth reconnect, or provider reauthorization is
  required.
- Workload resources remain opt-in (`resources: {}`), so existing partial resource overrides do not
  inherit new limits during this patch upgrade. Review the documented production examples and set
  complete requests and limits from observed workload usage.
- Google Workspace and GitHub wrapper root filesystems are now read-only with an ephemeral writable
  `/tmp`. Deployments that add integrations writing elsewhere must provide an explicit writable
  volume mount or override that workload's security context.
- Internal provider NetworkPolicies now require the AgentGateway Pod's
  `app.kubernetes.io/instance` label to match this Helm release. Wrapper-only deployments with an
  externally managed AgentGateway must apply that release label or provide an environment-owned
  NetworkPolicy extension.
- CORS still defaults to `*` and backend failure behavior still defaults to `failOpen` for upgrade
  compatibility; browser-facing production deployments should set explicit origins, and operators
  may opt into `failClosed`.

## [0.5.0] - 2026-09-28

### Added

- Add chart-native governed-platform integration: typed external policy configuration, private
  provider-lifecycle callers, shared HTTPS trust bundles, GitHub post-consent redirect origins,
  and additive environment, volume, and mount extension points across first-party workloads.
- Add an environment-neutral external-platform issuer example and operator documentation while
  keeping provider connection lifecycle routes private by default.
- Add a private GitHub vulnerability-reporting path plus contribution and community conduct
  guidance.

### Changed

- Require Kubernetes `>=1.32.0-0` in Helm chart metadata.
- Commit to supporting the authenticated `/oauth/{provider}/*` compatibility aliases throughout
  the complete `0.6.x` release line. Their earliest possible removal is `0.7.0`, following an
  announcement in preceding minor-release notes; new integrations should use `/connections/*`.

### Fixed

- Derive the GitHub MCP upstream Service URL from the actual Helm release/fullname instead of a
  hard-coded release name, while preserving an explicit `githubWrapper.env` override.
- Reject enabled AgentGateway installations that omit the protected resource URI or have no
  enabled backend target, and make the README installation example deploy a usable backend.

### Upgrade Notes

- No database migration, Secret-format change, OAuth reconnect, or provider reauthorization is
  required. All governed-platform extension values default to disabled or empty.
- Kubernetes versions below 1.32 are no longer supported; upgrade the cluster before installing
  this chart release.
- Existing valid AgentGateway installations already define a resource URI and enabled backend.
  Values that enabled the gateway without either are now rejected instead of producing an
  unusable deployment.
- Existing GitHub upstream overrides under
  `githubWrapper.env.GITHUB_MCP_UPSTREAM_URL` remain supported. The default now follows the
  release-derived Service name.

## [0.4.11] - 2026-09-19

### Added

- Add declarative Google Workspace operation denials and outbound-recipient domain guardrails
  across named, generated, helper, and classified low-level GWS calls. The low-level tool remains
  available for other pinned operations.
- Add redacted lifecycle and policy-denial diagnostics, including resolved operation and stable
  IDs for unlabelled YAML rules. Document safe Google Docs positional-write practices in the
  shipped GWS skill.

### Fixed

- Preserve Google's alternative method scopes, report tool-specific missing scopes without
  disabling the whole connection, and expose phase, error category, and renewal timing in
  `google_oauth_status`. Eligible rows affected by the earlier scope-poisoning bug can recover
  when their configured consent scopes are intact.
- Evaluate scope-based policy allows against every usable scope in the stored grant rather than
  every possible method alternative, and reject a token if its grant changes after policy
  evaluation. Existing scope-based deny rules remain conservative.
- Clarify that the authorization-broker NetworkPolicy source must select the
  actual data-plane proxy Pods or observed source CIDRs in Gateway API and
  Ingress deployments. The fail-closed, exactly-one-source requirement remains.
- Add opt-in runtime Secret-key allowlists for Google Workspace, GitHub, and
  database wrappers so an aggregate Secret can hold the private signing JWKS
  without importing it into workload environments. Existing whole-Secret
  `envFrom` behavior remains when an allowlist is empty.

### Upgrade Notes

- No ingress, Secret, or database migration is required for existing installs.
  Operators using one aggregate signing/runtime Secret should set non-empty
  `secretRef.envKeys` lists for each importing wrapper and omit the signing key.
- Review YAML `match.scope` allow rules before rollout: a narrow allow no longer admits a broader
  usable Google grant. Full Drive also no longer satisfies `drive.apps.readonly`; users of
  `apps.list` may need consent for that scope. Raw GWS calls must resolve to a pinned command;
  caller-supplied scopes cannot authorize an unclassified operation.
- The outbound-recipient guard applies only when explicitly configured. In that mode, opaque or
  indirect mail-producing calls fail closed, and OPA receives normalized recipient domains
  instead of message arguments. Existing policies without this guard are unchanged.

## [0.4.10] - 2026-09-14

### Fixed

- Allow deployments that already own their `/mcp` and provider routes through Gateway API to
  expose the broker using an opt-in, exact-path HTTPRoute without creating a second Ingress.
  Existing Ingress deployments and chart defaults are unchanged.

### Documentation

- Add a Gateway API values overlay and a safe operator-side signing-JWKS generation example.
  Constrained DCR is enabled in the overlay but remains disabled by default in the chart.

## [0.4.9] - 2026-09-13

### Added

- Add a shared, versioned Google and GitHub connection lifecycle with status, manual refresh,
  authorization, and disconnect operations. Existing `/oauth/{provider}/*` routes remain available
  as compatibility aliases.
- Track encrypted provider credential generations in a durable custody ledger, with bounded
  lifecycle metrics and adapter conformance tests.

### Fixed

- Make disconnect locally effective before provider cleanup and prevent stale callbacks or
  renewals, including writes from older replicas, from reactivating a disconnected connection.
- Commit provider-issued renewal credentials before validation or activation, retain rejected
  credentials for revocation, and apply backoff to retryable cleanup without losing custody.
- Preserve scope checks and transient error classifications across concurrent renewal and broker
  paths.

### Upgrade Notes

- Run forward-only OAuth token-store migrations `005`, `006`, and `007` before starting the upgraded
  wrappers. The base Compose stack runs them for new and existing database volumes. For Helm,
  enable the `oauthMigrations` hook with its datastore Secret reference or run the migrations
  separately before rollout; the hook is disabled by default.
- In-flight OAuth authorizations created by an older replica without the new activation guard must
  be restarted. Existing Google and GitHub credentials retain legacy compatibility during the
  rolling deployment; do not remove `encrypted_refresh_token` yet. No new OAuth client or scopes
  are required.

## [0.4.8] - 2026-09-08

### Fixed

- Keep each enabled Google Workspace and GitHub tool catalog stable before provider consent,
  after consent, and after disconnect so clients that cache their initial `tools/list` response can
  use the same tool handles without reconnecting.
- Return a structured `provider_oauth_required` tool result when a cached data tool is called
  without a matching provider grant, naming the provider connection helper without resolving a
  provider token or contacting the provider API.

### Changed

- Derive the GitHub wrapper catalog locally from the exact pinned GitHub MCP Server v1.6.0 schemas
  and configured toolsets, and reject unselected known tools before policy, credential, or upstream
  work.
- Gate chart publication on a published-image full-bundle journey that uses one MCP session and one
  initial `tools/list` across Google and GitHub consent, successful calls, and disconnect.

### Upgrade Notes

- No configuration, Secret, database migration, OAuth client, scope, HOP-1, policy, or NetworkPolicy
  change is required. Clients will now see enabled provider data tools before provider consent;
  invoking one before consent returns `provider_oauth_required` instead of requiring catalog
  refresh or reconnection.

## [0.4.7] - 2026-09-07

### Fixed

- Publish authorization-broker public RSA keys with verification semantics while retaining
  sign-only private signing keyrings, allowing both `jose`-based provider wrappers to validate the
  exact broker token already authenticated and forwarded by AgentGateway.
- Gate chart publication on a release-image Kubernetes broker journey that requires one broker
  token to expose the combined Google Workspace and GitHub pre-consent tool catalog.

### Security

- Add bounded wrapper authentication diagnostics that report only stable failure classifications,
  without returning raw validator errors, token claims, or bearer credentials.
- Preserve fail-closed rejection of missing credentials and tokens with an invalid issuer,
  audience, signature, or expiration in the broker fanout release gate.

### Upgrade Notes

- No configuration, Secret, signing-key rotation, database migration, OAuth client, scope, or
  NetworkPolicy change is required. Existing private keyrings may continue declaring
  `key_ops: ["sign"]`; MCP-GW now projects their public JWKS entries as verification keys.

## [0.4.6] - 2026-09-06

### Fixed

- Propagate the chart-generated authorization-broker verification profile to the GitHub wrapper,
  preserving every configured HOP-1 issuer and allowing Google and GitHub MCP initialization to
  succeed with the same broker-issued access token.
- Add a chart-owned DNS-label-bounded Service derived from
  `<fullname>-authorization-broker` and use it for internal broker JWKS retrieval and public
  broker-route backends while keeping the public HTTPS `jwks_uri` unchanged.
- Retain Google Workspace's in-process broker verification and broker-disabled direct HOP-1
  behavior, including direct-Google deployments.

### Security

- Restrict broker pod ingress to the existing Ingress source, AgentGateway, and—only when
  enabled—the GitHub wrapper on the broker's exact TCP port; no unrestricted egress is added.
- Reject manually duplicated broker issuers, the reserved `mcp-oauth-broker` generated profile
  name, and issuer/resource configurations inconsistent with the chart-managed public MCP
  contract.

### Upgrade Notes

- Operators must not duplicate the broker issuer or use the generated profile name
  `mcp-oauth-broker` under `hop1.issuers`; the chart now generates and propagates that trust
  automatically. Existing explicit issuer profiles remain unchanged.
- The new authorization-broker Service selects the existing Google Workspace pods in v0.4.6; no
  standalone broker workload, bearer-token behavior, credential, scope, or lifetime changes are
  included.

## [0.4.5] - 2026-09-05

### Fixed

- Canonicalize an authorization-broker issuer with or without one trailing slash to the same exact
  value across authorization-server metadata, protected-resource metadata, broker JWTs,
  AgentGateway trust, and JWKS endpoint construction.
- Prevent direct MCP clients from completing OAuth but receiving no tools because AgentGateway
  trusted a slash-terminated issuer while the broker issued a slashless `iss` claim.

### Security

- Preserve exact issuer validation at the MCP boundary and reject broker issuer values containing
  repeated trailing slashes instead of weakening JWT issuer matching.

### Upgrade Notes

- Existing slashless broker issuer values remain unchanged. A value with one trailing slash now
  renders and runs as its slashless canonical equivalent; no credential or database migration is
  required.

## [0.4.4] - 2026-09-05

### Fixed

- Accept constrained DCR registrations that request both `authorization_code` and `refresh_token`,
  while preserving authorization-code-only clients and applying the compatible RFC 7591 defaults
  for omitted grant and response metadata.
- Issue rotating MCP-GW refresh credentials to eligible dynamic public clients so short-lived MCP
  access tokens can be renewed without repeating interactive Google sign-in.
- Keep dynamic registrations persistent by default because RFC 7591 registration responses expose
  no client-expiry signal. An explicit positive client TTL remains available and caps the associated
  refresh family to the same deadline.

### Security

- Bind refresh credentials to the exact client, issuer-qualified principal, MCP resource, and
  non-widening scope; persist only SHA-256 token digests; serialize concurrent rotation per family;
  and revoke every descendant when a consumed credential is replayed.
- Preserve public-client PKCE, state and nonce separation, exact MCP token audience, provider-token
  isolation, Google Workspace grants, and existing trusted-issuer behavior.

### Upgrade Notes

- Run OAuth migrations `003_broker_refresh_tokens.sql` and
  `004_persistent_dcr_clients.sql` before the updated Google Workspace wrapper becomes ready. The
  chart's existing `oauthMigrations` hook performs this when enabled.
- Native clients such as Codex require
  `googleWorkspace.authorizationBroker.dcr.allowLoopbackRedirects=true`; the secure chart default
  remains `false` and must be enabled deliberately by the deployment owner.
- Set `googleWorkspace.authorizationBroker.dcr.clientTtlMs=0` for persistent dynamic
  registrations. A positive value intentionally expires registrations and limits refresh-family
  lifetime.

## [0.4.3] - 2026-09-04

### Fixed

- Finalize the generated broker keyring as a read-only fixture and mount its dedicated secret
  directory during local and release integration tests. This matches Kubernetes Secret volume
  access semantics for the non-root wrapper and avoids Linux host-ownership failures.
- Run the broker integration smoke on Ubuntu pull requests against an immutable published
  AgentGateway digest so host-to-container permission regressions fail before a release tag.
- Supersede the unpublished v0.4.2 tag. v0.4.3 is the first artifact release after v0.4.0 and
  includes the hybrid broker-discovery and AgentGateway rollout fixes recorded below.

## [0.4.2] - 2026-09-04

### Fixed

- Wait for the generated broker signing JWKS to contain complete, valid JSON before starting the
  local and release integration containers. This removes a Linux bind-mount race that could start
  the Google Workspace wrapper while the fixture was still writing its keyring.
- Supersede the unpublished v0.4.1 tag. v0.4.2 is the first artifact release after v0.4.0 and
  includes the hybrid broker-discovery and AgentGateway rollout fixes recorded below.

## [0.4.1] - 2026-09-04

### Fixed

- Keep every configured internal HOP-1 issuer and the public Google authorization broker as valid
  authentication providers while advertising only the broker issuer from MCP protected-resource
  metadata. Public clients can now discover authorization and DCR without exposing cluster-only
  issuer URLs.
- Restart AgentGateway pods automatically when the chart-generated gateway ConfigMap changes,
  preventing `subPath` mounts from retaining stale authentication or routing configuration.

### Upgrade Notes

- Existing internal workload issuer and token semantics are unchanged. Hybrid deployments continue
  accepting internal workload tokens alongside broker-issued public-client tokens.
- AgentGateway receives a rolling restart when its rendered ConfigMap changes. No product-specific
  values, credentials, or manual cluster mutation are part of this release.

## [0.4.0] - 2026-09-03

### Added

- Add opt-in, version-pinned governance catalogs for the complete GitHub MCP v1.6.0 and Google
  Workspace CLI v0.22.5 tool surfaces.
- Publish exact grant contracts for 84 GitHub tools and 280 Google Workspace tools while keeping
  provider OAuth controls outside ordinary tool authority.

### Security

- Classify GitHub operations with exact, argument-aware read, write, and destructive semantics and
  reject unknown tools or selectors before policy, credential lookup, or upstream execution when
  the governed catalog is enabled.
- Reclassify 22 Google Workspace operations whose non-DELETE methods can delete content, revoke
  authority, or terminate live activity as destructive under the governed catalog.

### Upgrade Notes

- Existing deployments are unchanged unless they explicitly set `GITHUB_MCP_GOVERNANCE_CATALOG`
  or `GOOGLE_WORKSPACE_GOVERNANCE_CATALOG` to the documented exact catalog identifier.
- Google Workspace deployments opting into the new catalog must replace existing `write` grants
  with `destructive` grants for the 22 reclassified operations. Tool names and per-service authority
  keys such as `drive`, `gmail`, and `calendar` are unchanged.

## [0.3.2] - 2026-08-23

### Changed

- Publish every first-party runtime image as a signed linux/amd64 and linux/arm64
  OCI index. Release CI now builds all components for arm64 before publication.

## [0.3.1] - 2026-08-23

### Security

- Bind the GitHub OAuth callback to its single-use provider state record before
  resolving the authenticated HOP-1 principal, so concurrent or replayed callbacks
  cannot be associated with the wrong authorization attempt.
- Revoke the saved GitHub provider token when an authorized caller disconnects,
  preventing a disconnected consent from remaining usable upstream.

## [0.3.0] - 2026-08-20

### Added

- Add an optional standards-compatible MCP OAuth authorization broker with authorization-server
  and protected-resource metadata, public PKCE authorization-code flows, constrained dynamic client
  registration or immutable static clients, public JWKS rotation, and short-lived tokens whose
  audience is the exact MCP resource.
- Add typed Helm configuration for the broker's public routes, AgentGateway trust, exact Ingress and
  NetworkPolicy exposure, and read-only projection of an operator-owned signing keyring Secret.
- Extend provider conformance coverage and the generated release handoff with the broker's tested
  client, registration-mode, public-route, signing-keyring, and GitOps ownership contracts.

### Security

- Keep provider credentials out of broker tokens and responses, issue no refresh tokens or public
  client secrets, consume broker transactions and authorization codes once, and keep client state,
  broker-to-Google CSRF state, nonce, and authorization code distinct.
- Verify upstream Google identity assertions by signature and RS256 algorithm, exact issuer, client
  audience and authorized party, expiry, nonce, stable subject, verified email, and bounded numeric
  issuance time before issuing an MCP token.
- Fail closed on unsafe public URLs, redirect URIs, route collisions, confidential-client
  authentication, untrusted proxy inputs, oversized registration requests, and incoherent Helm
  configuration while keeping private provider helpers off the public broker surface.

### Changed

- Preserve trusted-issuer and Google-broker users as distinct `(issuer, subject)` principals rather
  than linking identities by email, and keep provider consent separate from broker authentication.
- Document reauthorization as the public-client renewal mechanism and limit compatibility claims to
  the protocol fixtures and tested-client evidence recorded by the release.

## [0.2.12] - 2026-08-18

### Fixed

- Match HOP-1 identities against any verified GitHub account email, allowing a verified corporate
  secondary email while continuing to reject unverified or mismatched identities.
- Adapt AgentGateway-generated GitHub MCP discovery and invocation requests to the upstream HTTP
  contract, including request method, name, client metadata, and primitive parameter headers, so
  GitHub tools remain discoverable and callable.

## [0.2.11] - 2026-08-13

### Fixed

- Keep MCP resource discovery protocol-valid before GitHub provider consent while rejecting
  malformed discovery requests instead of silently converting them into empty results.

## [0.2.10] - 2026-08-12

### Fixed

- Make projected HOP-1 introspection credentials group-readable only by agentgateway's explicit
  non-root runtime identity, preventing permission-denied authentication failures in Kubernetes.

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

[Unreleased]: https://github.com/apelogic-ai/mcp-gw/compare/v0.5.5...HEAD
[0.5.5]: https://github.com/apelogic-ai/mcp-gw/compare/v0.5.4...v0.5.5
[0.5.4]: https://github.com/apelogic-ai/mcp-gw/compare/v0.5.3...v0.5.4
[0.5.3]: https://github.com/apelogic-ai/mcp-gw/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/apelogic-ai/mcp-gw/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/apelogic-ai/mcp-gw/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/apelogic-ai/mcp-gw/compare/v0.4.11...v0.5.0
[0.4.11]: https://github.com/apelogic-ai/mcp-gw/compare/v0.4.10...v0.4.11
[0.4.10]: https://github.com/apelogic-ai/mcp-gw/compare/v0.4.9...v0.4.10
[0.4.9]: https://github.com/apelogic-ai/mcp-gw/compare/v0.4.8...v0.4.9
[0.4.8]: https://github.com/apelogic-ai/mcp-gw/compare/v0.4.7...v0.4.8
[0.4.7]: https://github.com/apelogic-ai/mcp-gw/compare/v0.4.6...v0.4.7
[0.4.6]: https://github.com/apelogic-ai/mcp-gw/compare/v0.4.5...v0.4.6
[0.4.5]: https://github.com/apelogic-ai/mcp-gw/compare/v0.4.4...v0.4.5
[0.4.4]: https://github.com/apelogic-ai/mcp-gw/compare/v0.4.3...v0.4.4
[0.4.3]: https://github.com/apelogic-ai/mcp-gw/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/apelogic-ai/mcp-gw/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/apelogic-ai/mcp-gw/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/apelogic-ai/mcp-gw/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/apelogic-ai/mcp-gw/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/apelogic-ai/mcp-gw/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/apelogic-ai/mcp-gw/compare/v0.2.12...v0.3.0
[0.2.12]: https://github.com/apelogic-ai/mcp-gw/compare/v0.2.11...v0.2.12
[0.2.11]: https://github.com/apelogic-ai/mcp-gw/compare/v0.2.10...v0.2.11
[0.2.10]: https://github.com/apelogic-ai/mcp-gw/compare/v0.2.9...v0.2.10
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
