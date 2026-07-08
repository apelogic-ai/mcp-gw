# Enterprise Kubernetes Examples

These files show how an organization can fork this repository, keep the shared
Helm chart public or upstream-aligned, and place environment-specific values in
a private overlay.

Recommended shape:

1. Fork the repo.
2. Keep `deploy/k8s/chart` close to upstream.
3. Copy `values-private-overlay.example.yaml` into a private config repo or
   private branch.
4. Replace placeholders for hostnames, image digests, secret-store names,
   cloud role annotations, and secret-manager keys.
5. Reconcile with Flux or Argo CD using the examples in this directory.

To add an MCP backend behind the same public `/mcp` endpoint, add the backend
runtime manifests or install its own chart, then append an entry under
`agentgateway.backends`. Use `serviceName`, `port`, and `path` for services
rendered by this chart, or `host` for a fully qualified in-cluster MCP URL. See
`values-extra-backend.example.yaml`.

Do not expose the agentgateway Admin UI on the public MCP ingress. Agentgateway
serves its Admin UI on port `15000` in standalone/Kubernetes modes, but the
upstream Kubernetes docs describe it as read-only and accessed with
`kubectl port-forward` rather than a public Service. If an organization needs a
persistent UI endpoint, put that in a private overlay with internal networking,
corporate SSO, and an allowlist.

Runtime secrets are expected to be provided through the External Secrets
Operator. Do not commit OAuth client secrets, token encryption keys, refresh
tokens, database passwords, or private JWKS material.

The public chart intentionally exposes only generic placeholders such as
`<org>`, `<aws-account-id>`, and `<mcp-hostname>`.
