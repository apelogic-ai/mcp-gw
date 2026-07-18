# Client Integration Runbook

Status: public enterprise template

This document describes how an enterprise MCP client, internal portal, or automation service can
integrate with MCP-GW. Replace all placeholder domains, client IDs, and environment values for your
deployment. Examples mention clients such as Claude or Codex, but the contract is agent-agnostic.

## Integration Modes

MCP-GW supports two common integration modes:

- **Direct MCP client:** a client that supports remote MCP and OAuth protected-resource discovery
  connects directly to `https://mcp.example.com/mcp`. Claude is an example of this pattern.
- **Control-plane mediated client:** an internal portal, backend service, CLI, or agent platform
  authenticates the user, starts provider connection flows, and calls MCP-GW with a HOP-1 bearer
  token. Codex or an internal agent service can use this pattern.

Both modes use the same provider credential model. MCP-GW owns downstream provider credentials and
never requires the client to store Google or GitHub refresh tokens.

## MCP Endpoint

Use the MCP endpoint for your deployment:

```text
https://mcp.example.com/mcp
```

The server also exposes OAuth discovery and callback helper routes under the same origin:

```text
https://mcp.example.com/.well-known/oauth-protected-resource/mcp
https://mcp.example.com/.well-known/oauth-authorization-server
https://mcp.example.com/authorize
https://mcp.example.com/token
```

Provider-specific OAuth helper routes live under the same origin:

```text
https://mcp.example.com/oauth/google/start
https://mcp.example.com/oauth/google/status
https://mcp.example.com/oauth/google/disconnect
https://mcp.example.com/oauth/github/start
https://mcp.example.com/oauth/github/status
https://mcp.example.com/oauth/github/disconnect
```

## OAuth Model

The integration uses two credential layers:

- **HOP-1:** client-to-MCP authorization. The client obtains a bearer token for the MCP gateway
  audience and sends it to `/mcp`.
- **HOP-2/provider OAuth:** per-user provider access. The gateway stores encrypted provider refresh
  tokens or provider credentials and refreshes provider access tokens for tool execution.

The initial direct-client flow is identity-only. It establishes a stable HOP-1 principal but does
not grant Google Workspace, GitHub, or any other downstream provider access. Keep
`HOP1_OAUTH_SCOPES` limited to identity claims such as `openid email`; configure provider scopes
separately.

For direct MCP clients that support OAuth protected-resource discovery, configure the MCP server URL
and the public OAuth client ID. Do not put the OAuth client secret into client-side settings. The
server-side `/token` endpoint injects the secret when it exchanges authorization codes.

For control-plane mediated clients, the control plane is responsible for issuing or acquiring the
HOP-1 bearer token. MCP-GW validates that token against configured issuers and audiences, then maps
the stable HOP-1 subject to provider credentials.

## Identity Requirements

Use one stable HOP-1 subject for provider connection and later MCP tool calls. Provider credentials
are stored under the authenticated gateway principal, not under the downstream provider identity.

Recommended HOP-1 token properties:

```text
issuer: https://idp.example.com
audience: https://mcp.example.com/mcp
subject: immutable user or service principal ID
email: display email, if available
```

Emails are useful for display, but they should not be the only durable principal identifier when an
issuer provides immutable user IDs.

## Google Cloud Setup

In the Google Cloud project that owns the OAuth client, configure the OAuth client with redirect
URIs for your direct MCP client callback, if any, and the MCP-GW provider callback:

```text
https://<client-callback-host>/api/mcp/auth_callback
https://mcp.example.com/oauth/google/callback
```

Enable the APIs required by the default tool surface:

```text
drive.googleapis.com
gmail.googleapis.com
calendar-json.googleapis.com
docs.googleapis.com
slides.googleapis.com
sheets.googleapis.com
tasks.googleapis.com
meet.googleapis.com
```

The default public surface is filtered to Drive, Gmail, Calendar, Docs, Sheets, Slides, Tasks,
limited Meet, and workflow helpers. Admin, Chat, Classroom, Cloud Platform, contacts/directory,
Forms, Keep, Groups, Apps Script, and user-profile-detail scopes are not exposed by default.

## Server Environment

The compose env file must provide:

```text
GOOGLE_OAUTH_CLIENT_ID=<google-oauth-client-id>
GOOGLE_OAUTH_CLIENT_SECRET=<google-oauth-client-secret>
GOOGLE_OAUTH_REDIRECT_URI=https://mcp.example.com/oauth/google/callback
GOOGLE_TOKEN_ENCRYPTION_KEY=<base64-encoded-32-byte-key>
HOP1_ISSUER=<issuer-url>
HOP1_JWKS_URL=<jwks-url>
HOP1_AUDIENCE=<mcp-gateway-audience>
HOP1_OAUTH_SCOPES="openid email"
HOP1_EMAIL_CLAIM=email
HOP1_SUBJECT_CLAIM=sub
```

`GOOGLE_TOKEN_ENCRYPTION_KEY` must decode to exactly 32 bytes:

```bash
openssl rand -base64 32
```

Multiple HOP-1 issuers can be configured with `HOP1_ISSUERS_JSON`; see
`deploy/compose/.env.example`.

Provider credentials for optional backends can be connected by an external control plane or internal
portal. See [provider-connection-flows.md](provider-connection-flows.md).

## Direct Client Connector Setup

1. Create or edit a remote MCP connector in the client.
2. Set the MCP server URL to `https://mcp.example.com/mcp`.
3. Set the OAuth client ID to the OAuth client configured for HOP-1.
4. Do not configure the client secret in the remote client.
5. Connect the connector and complete the identity-only gateway sign-in.
6. Confirm the provider helpers `google_oauth_status`, `google_oauth_start`, and the equivalent
   helpers for other enabled providers appear under the connector.
7. Ask the agent to connect Google Workspace. It should call `google_oauth_start` and return an
   authorization URL.
8. Open the URL, approve Google Workspace access, and ask the client to refresh its tools.
9. Confirm the full Google Workspace tool catalog appears. Repeat with `github_oauth_start` or other
   provider helpers as needed.

Clients may cache connector state. Disconnect/reconnect after changes to OAuth behavior, Google
scopes, or the visible tool catalog.

If the client also offers native Google, GitHub, or other provider connectors, decide whether those
native connectors should be disconnected. Keeping both native and MCP-GW connectors enabled can
produce duplicated tools and different policy behavior.

## Control Plane Setup

An internal portal, CLI, backend service, or agent platform can integrate without relying on the MCP
client's interactive OAuth flow:

1. Authenticate the user with the enterprise identity provider.
2. Mint or obtain a HOP-1 bearer token whose audience is the MCP-GW `/mcp` URL.
3. Start provider OAuth through MCP-GW with that bearer token.
4. Store no downstream provider refresh token in the control plane.
5. Call `/mcp` with the same HOP-1 principal when tools are used.

See [Provider Connection Flows](provider-connection-flows.md) for provider start, callback, status,
and disconnect examples.

## Tool Surface

Before Google consent, the connector exposes `google_oauth_status` and `google_oauth_start`. After
consent, it also exposes:

- curated tools such as `google_drive_files_list`, `google_docs_get`, and
  `google_calendar_events_insert`;
- generated `gws_*` tools for the filtered Google Workspace service families;
- `google_workspace_gws`, a guarded CLI passthrough for advanced `gws` commands.

Example generic call payload:

```json
{
  "name": "google_workspace_gws",
  "arguments": {
    "argv": [
      "slides",
      "presentations",
      "get",
      "--params",
      "{\"presentationId\":\"presentation-id\"}"
    ],
    "scopes": ["https://www.googleapis.com/auth/presentations.readonly"]
  }
}
```

The generic tool rejects unsupported/excluded Google Workspace scopes before token lookup.

## GitHub Backend

The optional GitHub backend packages the official GitHub MCP server behind an MCP-GW wrapper. The
wrapper validates HOP-1, resolves the user's GitHub credential from MCP-GW-owned storage, and
forwards calls to the official upstream server with a GitHub bearer token.

For GitHub OAuth, register a GitHub OAuth app with:

```text
Homepage URL: https://mcp.example.com
Authorization callback URL: https://mcp.example.com/oauth/github/callback
```

Then configure the gateway environment with the GitHub client ID, secret, callback URL, scopes, and
token encryption key. See [servers/github-mcp/README.md](../servers/github-mcp/README.md).

## Multi-Backend Routing

MCP-GW uses agentgateway as the MCP front door. Agentgateway can multiplex more than one MCP
backend behind the same `/mcp` endpoint, and deployment templates render those targets from the
backend registry or Helm `agentgateway.backends` values.

MCP-GW deployment templates set `prefixMode: never`, so agentgateway routes by exact advertised
tool name and forwards the original upstream tool name unchanged. Backend wrappers own stable
provider prefixes, for example `google_drive_files_list` and `github_search_repositories`. Do not
depend on agentgateway to add or strip prefixes. Validate the visible tool catalog and reconnect
clients that cache tool permissions after changing the active backend set.

Generated configs use `failureMode: failOpen` so one unavailable optional backend does not make
every MCP initialization fail. It is still an operator error to advertise a backend whose runtime,
credentials, or DNS are not deployed.

## Enterprise Deployment Checklist

Before making MCP-GW available to users:

- Choose a public HTTPS hostname, for example `https://mcp.example.com`.
- Configure HOP-1 issuers, audiences, JWKS URLs, and stable principal claims.
- Configure provider OAuth apps and register exact callback URLs.
- Enable required provider APIs, such as Google Workspace APIs.
- Generate and store provider token encryption keys in a secret manager.
- Decide which MCP backends are enabled on the shared `/mcp` route.
- Apply Google Workspace policy YAML or external OPA policy if required.
- Keep agentgateway Admin UI internal; do not expose it on the public MCP ingress.
- Validate the visible tool catalog in every target client.
- Document reconnect expectations after OAuth scope or tool catalog changes.
- Do not commit real `.env` files, OAuth secrets, token encryption keys, refresh tokens, Terraform
  state, cloud account IDs, or production hostnames to a public repository.

## Troubleshooting

OAuth registration fails:

- Confirm the client has the OAuth client ID.
- Confirm the client callback URI is authorized in Google Cloud.
- Confirm the MCP protected-resource metadata is reachable.

Google shows `redirect_uri_mismatch`:

- Add the exact redirect URI shown by Google to the OAuth client.

Client connects but shows no tools:

- Check gateway and wrapper logs for `initialize` and `tools/list`.
- Confirm all visible tool names are at most 64 characters for clients with that limit.
- Disconnect/reconnect if the client cached an older catalog.

Tool call fails with `Google account must be reconnected`:

- Confirm `google_oauth_start` completed and the provider callback persisted a Google
  `refresh_token`.
- Confirm `GOOGLE_TOKEN_ENCRYPTION_KEY` decodes to exactly 32 bytes.
- Reconnect after changing token persistence or scopes.

Tool call fails with `API not enabled for your GCP project`:

- Enable the named Google API and retry after propagation.

Tool call fails with a `gws` runtime error:

- Confirm the wrapper image includes `node`, CA certificates, and a compatible glibc runtime.

## Useful Commands

Deploy with a private env file:

```bash
DEV_ENV_FILE=/path/to/private.env AWS_PROFILE=<profile> AWS_REGION=<region> bun run deploy:dev
```

Smoke unauthenticated MCP challenge:

```bash
curl -i https://mcp.example.com/mcp
```

Expected status is `401` with a `WWW-Authenticate` header pointing at protected-resource metadata.
