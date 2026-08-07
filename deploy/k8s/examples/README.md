# Enterprise Kubernetes Examples

These files show how an organization can consume the versioned Helm chart and
place environment-specific values in a private GitOps repository.

Recommended shape:

1. Pin a released OCI chart version.
2. Copy `values-private-overlay.example.yaml` into a private config repo.
3. Replace placeholders for hostnames, image digests, service-account annotations,
   existing Kubernetes Secret names, sizing, and scheduling policy.
4. Set `hop1.issuers` to the deployment-owned issuer, audience, JWKS URL, and
   non-empty algorithm allowlist. Set
   `agentgateway.mcpAuthentication.resourceMetadata.resource` to the public MCP
   URL. Keep `resourceMetadata.scopesSupported` aligned with the wrappers'
   `HOP1_OAUTH_SCOPES`; the default identity scopes are `openid` and `email`.
5. Reconcile with Flux or Argo CD using the examples in this directory.

To add an MCP backend behind the same public `/mcp` endpoint, add the backend
runtime manifests or install its own chart, then append an entry under
`agentgateway.backends`. Use `serviceName`, `port`, and `path` for services
rendered by this chart, or `host` for a fully qualified in-cluster MCP URL. See
`values-extra-backend.example.yaml`.

To enable the bundled official GitHub MCP server, use
`values-github-mcp.example.yaml` as the overlay starting point. The upstream
server expects a GitHub bearer token in the inbound `Authorization` header in
HTTP mode, so production deployments still need a credential bridge that maps
the authenticated HOP-1 principal to the user's GitHub credential before
forwarding.

To enforce Google Workspace tool policy without running an external policy
service, enable `googleWorkspace.policy` and provide YAML policy content in a
private values overlay. See `values-google-policy.example.yaml`.

Do not expose the agentgateway Admin UI on the public MCP ingress. Agentgateway
serves its Admin UI on port `15000` in standalone/Kubernetes modes, but the
upstream Kubernetes docs describe it as read-only and accessed with
`kubectl port-forward` rather than a public Service. If an organization needs a
persistent UI endpoint, put that in a private overlay with internal networking,
corporate SSO, and an allowlist.

Runtime secrets are referenced as existing Kubernetes Secrets. Create or
reconcile those Secrets from the organization's chosen secret manager outside
this chart. Do not commit OAuth client secrets, token encryption keys, refresh
tokens, database passwords, or private JWKS material.

The chart enables no workload by default. Enabling agentgateway or an
authenticated wrapper without at least one complete `hop1.issuers` profile is
a schema error. The file `values-enterprise-contract.example.yaml` is a
non-deployable test fixture that demonstrates the complete values shape; do not
use its fixture coordinates as deployment configuration.

## OAuth schema migrations

Enable `oauthMigrations` when Google Workspace or GitHub provider consent uses
the shared PostgreSQL token store. The pre-install/pre-upgrade Helm hook runs
all checked-in migrations under a transaction-scoped PostgreSQL advisory lock
and blocks the application rollout if a migration fails. Reference an existing
Secret key containing `TOKEN_STORE_DSN`; include `sslmode=require` (or the
stricter mode required by the database operator) when PostgreSQL requires TLS.
The chart does not create database credentials or put a DSN in rendered values.

The public chart and examples contain only generic public coordinates and placeholder values.
