# GitHub MCP Server

This bundled backend runs the official GitHub MCP server:

`ghcr.io/github/github-mcp-server:v1.6.0`

The server is optional and is wired into the generated federated agentgateway
config as `github-mcp`. It is not included in the base Google Workspace-only
config.

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

## Credential Boundary

In HTTP mode, the official GitHub MCP server reads the GitHub credential from
the inbound `Authorization` header. The current bundle therefore works as a
runtime package, but production client paths still need the next credential
bridge slice:

1. validate the client or enterprise HOP-1 identity at MCP-GW;
2. resolve that principal's GitHub credential from MCP-GW-owned storage;
3. call the official GitHub MCP server with a GitHub bearer token, not the
   client identity token.

Until that bridge exists, do not expose this backend on a production route that
expects client identity tokens to be accepted directly by the upstream GitHub
MCP server.

## Follow-Ups

- MCP-GW-owned GitHub OAuth or GitHub App token storage.
- Compatibility aliases for existing client-specific GitHub tool names.
- Gateway-level read/write policy, response limits, audit events, and approval
  semantics around the upstream tool calls.
