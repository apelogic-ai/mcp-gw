# Release Handoff Contract

Every tagged MCP Gateway release publishes a self-contained operator handoff alongside its GitHub
Release. The generated handoff records exact image and OCI chart digests. This document describes the
stable information an external GitOps repository can rely on.

## Published Artifacts

- OCI chart: `oci://ghcr.io/apelogic-ai/charts/mcp-gateway`, versioned with the release SemVer.
- First-party images: the pinned agentgateway derivative, Google Workspace wrapper, and GitHub
  wrapper, each published with the release tag and deployable by digest.
- Supply-chain evidence: an SPDX JSON SBOM, JSON vulnerability report, digest file, and GitHub
  build-provenance attestation for every first-party image. The chart also receives provenance tied
  to its OCI digest.

The official GitHub MCP Server is an external dependency. Operators should pin or mirror it by digest
in private values just like any other externally maintained image.

The optional `dbMcp` adapter is also externally supplied. Its public default repository is a
placeholder; set `dbMcp.image.repository` and preferably `dbMcp.image.digest` before enabling it.

## Network And Health Contract

| Component                  | Port | MCP path | Exposure                    |
| -------------------------- | ---: | -------- | --------------------------- |
| agentgateway               | 8080 | `/mcp`   | ClusterIP; optional ingress |
| Google Workspace wrapper   | 8080 | `/mcp`   | ClusterIP only              |
| GitHub wrapper             | 8080 | `/mcp`   | ClusterIP only              |
| Official GitHub MCP Server | 8082 | `/mcp`   | ClusterIP only              |

Each workload has independently configurable liveness and readiness probes under its `probes`
values. The gateway readiness probe checks the gateway process, not remote issuer availability.

## Existing Kubernetes Secret Contract

The chart never creates provider credentials. A private values file supplies an existing Kubernetes Secret
name for each enabled adapter.

Google Workspace keys:

- `TOKEN_STORE_DSN`
- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `GOOGLE_OAUTH_REDIRECT_URI`
- `GOOGLE_TOKEN_ENCRYPTION_KEY`

GitHub keys:

- `TOKEN_STORE_DSN`
- `GITHUB_OAUTH_CLIENT_ID`
- `GITHUB_OAUTH_CLIENT_SECRET`
- `GITHUB_OAUTH_REDIRECT_URI`
- `GITHUB_OAUTH_REDIRECT_AFTER_ALLOWED_ORIGINS` (when a separate browser UI receives post-consent redirects)
- `GITHUB_TOKEN_ENCRYPTION_KEY`

Issuer introspection credentials are not assigned a public fixed name. Each issuer selects an
existing Secret and key with `hop1.issuers[].introspection.credentialSecretKeyRef`.

An enabled authorization broker additionally selects one existing Secret key
through `googleWorkspace.authorizationBroker.signingKeyring.secretKeyRef`.
That key contains the private JWKS keyring and is projected read-only into the
Google wrapper. Release values, generated handoffs, environment variables, and
rendered manifests contain only the Secret reference and fixed file path—never
the JWKS payload or private key material.

## GitOps Consumption

Keep domains, issuer configuration, Secret names, sizing, scheduling, enabled adapters, and image
mirrors in a private values overlay. The public chart should be consumed directly; deployment teams
should not need to patch or fork its templates.

## OAuth Broker Handoff

For a release that enables direct-client OAuth, the handoff must also identify:

- the canonical MCP resource URI and MCP-GW authorization-server issuer;
- whether constrained DCR is enabled and therefore whether `/register` is public and advertised;
- the public route set, including the broker Google callback and metadata-advertised `jwks_uri`;
- the broker access-token lifetime, signing algorithm, active public key ID, and accepted public-key
  overlap without including private signing material;
- the existing signing-keyring Secret name/key reference expected by private
  GitOps, without copying the Secret payload;
- the chart-managed Ingress host/path contract and the generated AgentGateway
  broker-issuer trust entry, including confirmation that the MCP resource stays
  behind AgentGateway while broker authorization routes reach the wrapper;
- the exact namespace and pod labels used to admit only the environment's
  Ingress controller through the wrapper NetworkPolicy;
- the static-client or constrained-DCR registration mode and exact tested-client versions/evidence;
  and
- explicit exclusion of authenticated `/oauth/google|github/start|status|disconnect` handlers from
  the public ingress.

The first broker release renews access through a complete authorization-code + PKCE flow. It does
not issue a public refresh token. A source commit or local fixture is not a GitOps artifact; publish
this contract only with the exact versioned chart and image digests described above.

The generated release handoff describes the product capability with the exact typed chart paths,
route-derivation rules, static-only and DCR-enabled modes, signing-keyring JWKS schema, existing
Secret name/key reference fields, fixed read-only projection path, active-key/rotation contract, and
tested-client claim limits. Environment-specific issuer, resource, callback, Secret name, and active
`kid` remain GitOps-owned deployment evidence; they are never hard-coded into the product release.
