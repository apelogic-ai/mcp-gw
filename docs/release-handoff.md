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
- `GITHUB_TOKEN_ENCRYPTION_KEY`

Issuer introspection credentials are not assigned a public fixed name. Each issuer selects an
existing Secret and key with `hop1.issuers[].introspection.credentialSecretKeyRef`.

## GitOps Consumption

Keep domains, issuer configuration, Secret names, sizing, scheduling, enabled adapters, and image
mirrors in a private values overlay. The public chart should be consumed directly; deployment teams
should not need to patch or fork its templates.
