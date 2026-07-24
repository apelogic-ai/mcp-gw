# MCP Gateway

Agent-agnostic remote MCP gateway for Google Workspace tools, with a path for adding more backend
MCP servers behind one public `/mcp` endpoint.

The project currently packages:

- an `agentgateway` front door for remote MCP traffic and OAuth protected-resource metadata;
- a Bun/TypeScript Google Workspace MCP wrapper;
- an optional official GitHub MCP server backend for federated deployments;
- per-user Google OAuth token storage with encrypted refresh tokens;
- provider-owned OAuth helpers that expose each downstream tool catalog only after per-user consent;
- a `gws` subprocess executor using `GOOGLE_WORKSPACE_CLI_TOKEN` per call;
- Docker Compose, Terraform, Ansible, and Kubernetes deployment templates;
- tests, linting, formatting, and CI wiring.

## Architecture

There are two credential hops:

- **HOP-1 client to gateway:** the MCP client presents a bearer token from an issuer configured for
  the gateway and wrapper, such as Google OIDC, Okta, Entra, or a purpose-built identity service.
- **HOP-2 wrapper to Google:** the wrapper uses a per-user Google refresh token to mint short-lived
  Google Workspace access tokens for tool execution.

The HOP-1 bearer token identifies the caller. It is never forwarded to Google. The wrapper injects
only the HOP-2 Google access token into `gws`.

Initial MCP authentication is identity-only. Before a downstream provider is connected, its wrapper
advertises only provider-prefixed status and authorization helpers, such as `google_oauth_status`
and `google_oauth_start`. Completing that provider's consent flow unlocks its full tool catalog for
the same HOP-1 principal.

```text
MCP client
  -> agentgateway /mcp
  -> google-workspace wrapper
  -> gws CLI
  -> Google Workspace APIs
```

## Google Workspace Tool Surface

The wrapper exposes:

- curated stable tools such as `google_drive_files_list`, `google_docs_get`, and
  `google_calendar_events_insert`;
- generated `gws_*` tools for the currently enabled Google Workspace families;
- `google_workspace_gws`, a guarded raw `gws` passthrough for advanced use.

The default public-safe surface is intentionally filtered to Drive, Gmail, Calendar, Docs, Sheets,
Slides, Tasks, limited Meet, and workflow helpers. Admin, Chat, Classroom, Cloud Platform,
contacts/directory, Forms, Keep, Groups, Apps Script, and user-profile-detail scopes are not exposed
by default.

See [docs/gws-generated-catalog.md](docs/gws-generated-catalog.md) and
[servers/google-workspace/README.md](servers/google-workspace/README.md).

Admins can enforce Google Workspace tool policy with a YAML policy file and/or an external OPA
endpoint. See [docs/google-workspace-policy.md](docs/google-workspace-policy.md).

## Local Development

Install dependencies:

```bash
bun install
```

Run all local checks:

```bash
bun run ci
bun run deploy:check
```

Run only tests:

```bash
bun test
```

Copy the compose environment template and fill in local values:

```bash
cp deploy/compose/.env.example deploy/compose/.env
```

Do not commit real `.env` files, OAuth client secrets, token encryption keys, Terraform state, or
cloud credentials.

## Deployment

Deployment templates are provided for:

- local and DEV-style Docker Compose under [deploy/compose](deploy/compose);
- a single AWS Compose host under [deploy/infra](deploy/infra);
- Kubernetes/Helm under [deploy/k8s](deploy/k8s).

The checked-in deployment defaults pin the ApeLogic `agentgateway` fork image
`ghcr.io/apelogic-ai/agentgateway:v2026.07.17-apelogic.1`. That fork includes MCP
multi-provider authentication plus upstream `prefixMode: never` routing support required for
multiple HOP-1 clients and multiple MCP backends behind one `/mcp` endpoint. Do not replace it with
upstream `agentgateway` unless upstream has accepted equivalent MCP authentication behavior.
Production overlays should mirror or rebuild the pinned fork version into a private registry and pin
by digest.

The Kubernetes chart is intended for fork-and-overlay enterprise deployments. Keep
[deploy/k8s/chart](deploy/k8s/chart) close to upstream, then put org-specific hostnames, image
digests, identity annotations, and secret-manager paths in a private values overlay. Flux, Argo CD,
AWS External Secrets, and private overlay examples are in
[deploy/k8s/examples](deploy/k8s/examples).

Agentgateway backend targets are configured through `agentgateway.backends` in Helm values. The
checked-in Google Workspace, db-mcp, and optional GitHub MCP backends are examples of the pattern.
Deployment templates set `prefixMode: never`, so each backend wrapper must expose globally unique,
provider-prefixed tool names and agentgateway forwards those names unchanged. Additional MCP servers
can be added by appending a target in an overlay. See
[docs/backend-registry.md](docs/backend-registry.md).

The optional GitHub MCP bundle uses the official
`ghcr.io/github/github-mcp-server:v1.6.0` Streamable HTTP server. It is packaged as an MCP runtime
backend, but production HOP-1 flows still need a credential bridge that maps the authenticated
gateway principal to a GitHub bearer token before forwarding to the upstream GitHub server. See
[servers/github-mcp/README.md](servers/github-mcp/README.md).

Downstream provider credentials can be connected by an external control plane, internal portal, or
future built-in UI. See [docs/provider-connection-flows.md](docs/provider-connection-flows.md).
Enterprise MCP client integration guidance is in
[docs/client-integration-runbook.md](docs/client-integration-runbook.md).

Agentgateway has an Admin UI, but this chart does not expose it. Keep UI access internal through
`kubectl port-forward` or a private overlay protected by corporate network controls and SSO.

The deployment assets are templates. Replace placeholder domains, OAuth client IDs, redirect URIs,
cloud role ARNs, image digests, and secret values for each environment. Do not commit real runtime
secrets to this repository.

## Releases

Releases are SemVer Git tags with GitHub Releases. Enterprise forks should pin upstream release tags,
mirror or rebuild artifacts into private registries, and keep private deployment overlays outside the
public repo. See [docs/releases.md](docs/releases.md) and the bundled release-agent skill at
[skills/mcp-gw-release/SKILL.md](skills/mcp-gw-release/SKILL.md).

## License

MIT. See [LICENSE](LICENSE).

Before making a mirror public or accepting outside contributions, still run the checks in
[docs/publication-checklist.md](docs/publication-checklist.md), especially the git-history secret
scan.
