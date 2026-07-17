# MCP Backend Registry

The repository keeps each MCP backend in a small server-owned directory and
derives gateway target config from backend descriptors. This avoids hand-editing
every gateway config when adding another backend.

## Descriptor

Add a descriptor at `servers/<backend>/backend.yaml`:

```yaml
name: enterprise-search
host: http://enterprise-search:8080/mcp
toolPrefix: search
enabledByDefault: false
```

Fields:

- `name`: stable backend descriptor name.
- `host`: MCP HTTP endpoint used by Docker Compose generated configs.
- `toolPrefix`: unique tool namespace prefix for collision checks, docs, and
  generated agentgateway target names.
- `enabledByDefault`: whether the backend appears in the base gateway config.

Run the generator after changing descriptors:

```bash
bun scripts/generate-agentgateway-config.ts
bun run backends:check
```

`gateway/agentgateway/base.yaml` includes only default-enabled backends.
`gateway/agentgateway/federated.yaml` includes optional backends as well, but it
is not used by the default DEV Compose deployment. Do not mount the federated
config into the shared `/mcp` route unless every listed backend is deployed and
the target fan-out behavior has been tested for that environment.

Generated agentgateway configs set `failureMode: failOpen` on the MCP backend.
That means an unavailable optional target is skipped during MCP initialization
when at least one target is healthy. It does not make a missing backend usable;
it prevents one broken optional backend from taking down the entire shared MCP
route.

The generator does not set `prefixMode: always`. With one active MCP target,
agentgateway leaves upstream tool names unchanged, so the Google-only route
continues to expose existing names such as `google_drive_files_list`.
Agentgateway prefixes tools when more than one MCP target is active. Use short,
stable `toolPrefix` values and hand-test the resulting catalog before exposing a
multi-target route to clients that cache tool permissions.

## Docker Compose

For a backend that runs in Compose, add a service fragment under
`deploy/compose`. The db-mcp and official GitHub MCP integrations are optional
backend examples:

```bash
docker compose \
  -f deploy/compose/docker-compose.yaml \
  -f deploy/compose/docker-compose.db-mcp.yaml \
  --profile db-mcp up

docker compose \
  -f deploy/compose/docker-compose.yaml \
  -f deploy/compose/docker-compose.github-mcp.yaml \
  --profile github-mcp up
```

These optional Compose overlays start backend runtime containers only. They do
not mutate the shared agentgateway `/mcp` route. Expose optional backends through
an explicitly tested agentgateway config, a dedicated MCP route, or a
deployment-specific overlay.

## Kubernetes

The Helm chart renders agentgateway MCP targets from `agentgateway.backends`.
For services rendered by this chart, use `serviceName`, `port`, and `path`.
For services installed by another chart or namespace, use `host`.

```yaml
agentgateway:
  backends:
    - name: google-workspace
      enabled: true
      serviceName: google-workspace
      port: 8080
      path: /mcp
    - name: enterprise-search
      enabled: true
      host: http://enterprise-search.search.svc.cluster.local:8080/mcp
```

See `deploy/k8s/examples/values-extra-backend.example.yaml`.

The official GitHub MCP server is already modeled in chart values as
`githubMcp`, disabled by default. See
`deploy/k8s/examples/values-github-mcp.example.yaml` for the overlay shape.

## Public Repo Safety

Do not commit runtime secrets, OAuth client secrets, refresh tokens, database
passwords, private JWKS material, private hostnames, or cloud account details.
Keep org-specific values in private overlays.
