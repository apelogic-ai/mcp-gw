# Client Integration Runbook

Status: public template

This document describes how a remote MCP client can integrate with this gateway and the Google
Workspace backend. Replace all placeholder domains, client IDs, and environment values for your
deployment.

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

## OAuth Model

The integration uses two credential layers:

- **HOP-1:** client-to-MCP authorization. The client obtains a bearer token for the MCP gateway
  audience and sends it to `/mcp`.
- **HOP-2:** per-user Google Workspace access. The gateway stores an encrypted Google refresh token
  and refreshes Google access tokens for tool execution.

For clients that support OAuth protected-resource discovery, configure the MCP server URL and the
public OAuth client ID. Do not put the Google client secret into client-side settings. The server
side `/token` endpoint injects the secret when it exchanges authorization codes.

## Google Cloud Setup

In the Google Cloud project that owns the OAuth client, configure the OAuth client with redirect
URIs for your MCP client and deployment callback:

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

## Client Connector Setup

1. Create or edit a remote MCP connector in the client.
2. Set the MCP server URL to `https://mcp.example.com/mcp`.
3. Set the OAuth client ID to the OAuth client configured for HOP-1.
4. Do not configure the client secret in the remote client.
5. Connect the connector and approve the Google consent screen.
6. Confirm tools appear under the connector.

Clients may cache connector state. Disconnect/reconnect after changes to OAuth behavior, Google
scopes, or the visible tool catalog.

## Tool Surface

The connector exposes:

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

## Multi-Backend Routing

MCP-GW uses agentgateway as the MCP front door. Agentgateway can multiplex more than one MCP
backend behind the same `/mcp` endpoint, and deployment templates render those targets from the
backend registry or Helm `agentgateway.backends` values.

Single-backend deployments leave upstream tool names unchanged. For example, the default Google-only
route exposes `google_drive_files_list`, not a gateway-prefixed variant. Multi-backend deployments
may receive target prefixes from agentgateway to avoid collisions across providers. Validate the
visible tool catalog and reconnect clients that cache tool permissions after changing the active
backend set.

Generated configs use `failureMode: failOpen` so one unavailable optional backend does not make
every MCP initialization fail. It is still an operator error to advertise a backend whose runtime,
credentials, or DNS are not deployed.

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

- Confirm `/token` persists a Google `refresh_token`.
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
