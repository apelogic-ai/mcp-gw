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

- `name`: stable agentgateway target name.
- `host`: MCP HTTP endpoint used by Docker Compose generated configs.
- `toolPrefix`: unique tool namespace prefix for collision checks and docs.
- `enabledByDefault`: whether the backend appears in the base gateway config.

Run the generator after changing descriptors:

```bash
bun scripts/generate-agentgateway-config.ts
bun run backends:check
```

`gateway/agentgateway/base.yaml` includes only default-enabled backends.
`gateway/agentgateway/federated.yaml` includes optional backends as well.

## Docker Compose

For a backend that runs in Compose, add a service fragment under
`deploy/compose`. The db-mcp integration is the current optional backend
example:

```bash
docker compose \
  -f deploy/compose/docker-compose.yaml \
  -f deploy/compose/docker-compose.db-mcp.yaml \
  --profile db-mcp up
```

Use the generated federated agentgateway config when optional backends should be
reachable.

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

## Public Repo Safety

Do not commit runtime secrets, OAuth client secrets, refresh tokens, database
passwords, private JWKS material, private hostnames, or cloud account details.
Keep org-specific values in private overlays.
