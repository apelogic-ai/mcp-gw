# GitHub MCP Server

This bundled backend runs the official GitHub MCP server:

`ghcr.io/github/github-mcp-server:v1.6.0`

The server is optional and is wired into the generated federated agentgateway
config as `github-mcp`. It is not included in the base Google Workspace-only
config.

Agentgateway does not call the official server directly. It routes to the
`github-wrapper` service, which validates HOP-1 identity, resolves the user's
stored GitHub credential, and forwards MCP requests to the official upstream
server with a GitHub bearer token.

## Docker Compose

Run it with the federated Compose overlay:

```bash
docker compose \
  -f deploy/compose/docker-compose.yaml \
  -f deploy/compose/docker-compose.github-mcp.yaml \
  --profile github-mcp up
```

The container runs the official Streamable HTTP transport:

```bash
github-mcp-server http --port 8082 --base-path /mcp --scope-challenge
```

Default toolsets:

```text
default,actions,code_security,discussions,notifications,orgs,projects
```

Override with `GITHUB_MCP_TOOLSETS`.

The wrapper container runs:

```bash
bun run servers/github-mcp/wrapper/src/main.ts
```

Required wrapper environment:

```text
TOKEN_STORE_DSN
GITHUB_TOKEN_ENCRYPTION_KEY
HOP1_ISSUER / HOP1_JWKS_URL / HOP1_AUDIENCE / HOP1_EMAIL_CLAIM
```

`HOP1_ISSUERS_JSON` can replace the single-issuer variables for multi-issuer
deployments.

## Credential Boundary

In HTTP mode, the official GitHub MCP server reads the GitHub credential from
the inbound `Authorization` header. The wrapper owns that credential bridge:

1. validate the client or enterprise HOP-1 identity at MCP-GW;
2. resolve that principal's GitHub credential from MCP-GW-owned storage;
3. call the official GitHub MCP server with a GitHub bearer token, not the
   client identity token.

Do not expose the official GitHub MCP server directly on a production route that
expects client identity tokens. Only the wrapper should receive HOP-1 tokens.

## Follow-Ups

- GitHub OAuth callback routes and GitHub App installation support.
- Compatibility aliases for existing client-specific GitHub tool names.
- Gateway-level read/write policy, response limits, audit events, and approval
  semantics around the upstream tool calls.
