# GitHub MCP Server

This bundled backend runs the official GitHub MCP server:

`ghcr.io/github/github-mcp-server:v1.6.0`

The server is optional and is described in the generated federated agentgateway
config as `github-mcp`. It is not included in the base Google Workspace-only
config, and the DEV Compose overlay intentionally does not attach it to the
shared `/mcp` route.

Agentgateway does not call the official server directly. It routes to the
`github-wrapper` service, which validates HOP-1 identity, resolves the user's
stored GitHub credential, and forwards MCP requests to the official upstream
server with a GitHub bearer token.

## Docker Compose

Run the GitHub wrapper and official upstream server with the Compose overlay:

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

This overlay is runtime-only. It starts `github-wrapper` and `github-mcp`, but
does not replace the agentgateway config or advertise GitHub tools on the shared
`/mcp` endpoint. Attach GitHub through a gateway router, a dedicated MCP route,
or an explicitly tested deployment overlay.

Required wrapper environment:

```text
TOKEN_STORE_DSN
GITHUB_TOKEN_ENCRYPTION_KEY
GITHUB_OAUTH_CLIENT_ID
GITHUB_OAUTH_CLIENT_SECRET
GITHUB_OAUTH_REDIRECT_URI
HOP1_ISSUER / HOP1_JWKS_URL / HOP1_AUDIENCE / HOP1_EMAIL_CLAIM
```

`HOP1_ISSUERS_JSON` can replace the single-issuer variables for multi-issuer
deployments.

Optional guardrail environment:

```text
GITHUB_TOOL_ALIASES_JSON={}
GITHUB_POLICY_FILE=/etc/mcp-gw/github-policy.yaml
OPA_POLICY_URL=http://opa:8181/v1/data/mcp/allow
AUDIT_LOG_PATH=/var/log/mcp-gw/audit.jsonl
```

The wrapper applies policy and audit to `tools/call` before resolving the
user's GitHub token. Alias mappings rewrite compatibility tool names to the
official upstream tool name before policy and forwarding.

## GitHub OAuth

The wrapper exposes provider connection routes:

```text
GET  /oauth/github/start
POST /oauth/github/start
GET  /oauth/github/callback
GET  /oauth/github/status
POST /oauth/github/disconnect
```

Register `GITHUB_OAUTH_REDIRECT_URI` in the GitHub OAuth app as the public
gateway callback URL, for example:

```text
https://mcp-gw.example.com/oauth/github/callback
```

The start/status/disconnect routes require a HOP-1 bearer token. The callback
recovers identity from the OAuth state record, so browser redirects from GitHub
do not need to carry the bearer token.

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

- GitHub App installation support as an alternative to OAuth app user tokens.
- Compatibility aliases for concrete existing client-specific GitHub tool
  names.
- Approval semantics around high-risk upstream tool calls.
