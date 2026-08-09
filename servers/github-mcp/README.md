# GitHub MCP Server

This bundled backend runs the official GitHub MCP server:

`ghcr.io/github/github-mcp-server:v1.6.0`

The server is optional and is described in the generated federated agentgateway
config as `github-mcp`. It is not included in the base Google Workspace-only
config. A deployment overlay attaches it to the shared `/mcp` route.

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
does not replace the agentgateway config. Add the wrapper as a backend target in
the deployment's federated agentgateway configuration to advertise its tools on
the shared `/mcp` endpoint.

Required wrapper environment:

```text
TOKEN_STORE_DSN
GITHUB_TOKEN_ENCRYPTION_KEY
GITHUB_OAUTH_CLIENT_ID
GITHUB_OAUTH_CLIENT_SECRET
GITHUB_OAUTH_REDIRECT_URI
HOP1_ISSUER / HOP1_JWKS_URL / HOP1_AUDIENCE / HOP1_ALLOWED_ALGORITHMS
HOP1_EMAIL_CLAIM
HOP1_INTROSPECTION_URL / HOP1_INTROSPECTION_CLIENT_CREDENTIAL
```

`HOP1_ISSUERS_JSON` can replace the single-issuer variables for multi-issuer
deployments. Introspection is optional per issuer; when configured, every
authenticated request fails closed unless the issuer confirms the HOP-1 is
still active. Every issuer must declare a non-empty algorithm allowlist.

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

For the generic external control-plane contract, see
[../../docs/provider-connection-flows.md](../../docs/provider-connection-flows.md).

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
do not need to carry the bearer token. The callback stores a credential only
when GitHub's primary verified email case-insensitively matches the HOP-1 email
captured in that single-use state record. On mismatch, the wrapper attempts to
revoke only the newly issued token and stores nothing. Self-hosted or isolated
GitHub API deployments can override the token-revocation endpoint with
`GITHUB_OAUTH_TOKEN_REVOCATION_URL`.

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
