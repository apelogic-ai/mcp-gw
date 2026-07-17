# Provider Connection Flows

Status: public template

MCP-GW separates client identity from downstream provider credentials. The MCP client or external
control plane proves who the user is with a HOP-1 bearer token. MCP-GW then stores provider-specific
OAuth credentials under that authenticated principal and uses them for later MCP tool calls.

This document describes the generic integration contract for deployments that do not use a built-in
MCP-GW portal.

## Credential Model

MCP-GW uses two credential layers:

- **HOP-1:** caller-to-gateway identity. The caller presents a bearer token issued for the MCP-GW
  audience.
- **Provider OAuth:** gateway-to-provider credentials. MCP-GW stores encrypted provider credentials
  for the authenticated HOP-1 principal.

Provider tokens are keyed by:

```text
provider + hop1_issuer + hop1_subject
```

The HOP-1 bearer token is never forwarded to the provider. Provider access tokens are never returned
to the external control plane.

## External Control Plane Contract

An external control plane can be an internal portal, CLI, backend service, or agent platform. Its
responsibility is to authenticate the user, obtain a HOP-1 token for MCP-GW, and start provider
connection flows.

The control plane starts a provider OAuth flow by calling MCP-GW with the authenticated user's HOP-1
token:

```http
GET https://mcp-gw.example.com/oauth/<provider>/start?redirect_after=https%3A%2F%2Fportal.example.com%2Fintegrations%2F<provider>%2Fcomplete
Authorization: Bearer <hop1-user-token>
```

MCP-GW responds with a redirect to the provider consent screen:

```http
302 Location: https://provider.example.com/oauth/authorize?...
```

The control plane should send the user's browser to that `Location`.

The provider redirects back to MCP-GW:

```text
https://mcp-gw.example.com/oauth/<provider>/callback
```

The callback does not need the original bearer token. MCP-GW recovers the HOP-1 principal from the
OAuth state record created during `/start`, stores the provider credential, and redirects to the
original `redirect_after` value.

## Status and Disconnect

Connection status:

```http
GET https://mcp-gw.example.com/oauth/<provider>/status
Authorization: Bearer <hop1-user-token>
```

Example response:

```json
{
  "connected": true,
  "email": "user@example.com",
  "scopesRequired": ["repo", "read:org", "workflow", "notifications", "user:email"],
  "scopesGranted": ["repo", "read:org", "workflow", "notifications", "user:email"],
  "missingScopes": []
}
```

Disconnect:

```http
POST https://mcp-gw.example.com/oauth/<provider>/disconnect
Authorization: Bearer <hop1-user-token>
```

Expected response:

```http
204 No Content
```

If `connected` is `false`, the control plane should show a connect action. If `missingScopes` is
non-empty, the control plane should show a reconnect action.

## GitHub OAuth Example

Register a GitHub OAuth app with:

```text
Homepage URL: https://mcp-gw.example.com
Authorization callback URL: https://mcp-gw.example.com/oauth/github/callback
```

Configure MCP-GW with:

```text
ENABLE_GITHUB_MCP=1
GITHUB_OAUTH_CLIENT_ID=<github-oauth-client-id>
GITHUB_OAUTH_CLIENT_SECRET=<github-oauth-client-secret>
GITHUB_OAUTH_REDIRECT_URI=https://mcp-gw.example.com/oauth/github/callback
GITHUB_OAUTH_SCOPES="repo read:org workflow notifications user:email"
GITHUB_TOKEN_ENCRYPTION_KEY=<base64-encoded-32-byte-key>
```

The control plane starts the GitHub flow:

```http
GET https://mcp-gw.example.com/oauth/github/start?redirect_after=https%3A%2F%2Fportal.example.com%2Fintegrations%2Fgithub%2Fcomplete
Authorization: Bearer <hop1-user-token>
```

After connection, MCP clients call the gateway MCP endpoint with the same stable HOP-1 subject:

```http
POST https://mcp-gw.example.com/mcp
Authorization: Bearer <hop1-user-token>
Content-Type: application/json
Mcp-Protocol-Version: 2025-06-18
```

MCP-GW validates the caller, resolves the stored GitHub credential for that HOP-1 principal, and
forwards the call to the internal GitHub MCP backend.

## Identity Requirements

For each connected provider, the control plane must use the same stable HOP-1 identity for:

- provider connection start;
- provider status and disconnect;
- later MCP tool calls.

Use an immutable subject claim where possible. Emails are useful display attributes, but they can be
renamed, reassigned, or represented differently across issuers.

## Client Support Matrix

Clients that support MCP OAuth protected-resource discovery can authenticate directly to MCP-GW for
the MCP connection. They may still need an external control plane to connect downstream providers
that are not part of the MCP client's interactive OAuth flow.

Headless clients and internal portals should use the provider connection routes directly with a
trusted HOP-1 token.
