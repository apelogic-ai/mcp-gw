# Dynamic Client Interoperability Evidence

Status: implementation and repository verification complete; live client acceptance pending an
approved deployment of this change.

This document records the narrow interoperability contract for dynamic public MCP clients. It does
not broaden provider behavior, principal linking, token audiences, or deployment policy.

## Version-pinned client evidence

| Client                   | Evidence                                                                                                                                                              | Registration and renewal behavior                                                                                                                                                                                                                                                                            | Current claim                                                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Codex CLI 0.147.0        | Source tag `rust-v0.147.0`, commit `be6e8eac029b183056b7e4402879f15d2c85f61b`; pinned RMCP 3.0.0 tag `rmcp-v3.0.0`, commit `4e361b715fc70b8a09f0a8aeaedc160712a3472d` | Registers a public client with `authorization_code` and `refresh_token`, `token_endpoint_auth_method=none`, PKCE S256, and an ephemeral `http://127.0.0.1:<port>/callback/<12-character-server-bound-id>` redirect. Refreshes with the exact resource and granted scopes and adopts a rotated refresh token. | Exact source behavior and repository request-shape fixture verified. Live Codex login and post-expiry renewal remain pending deployment. |
| Claude remote connectors | [Claude connector authentication documentation](https://claude.com/docs/connectors/building/authentication)                                                           | Supports OAuth DCR, PKCE S256, hosted callback `https://claude.ai/api/mcp/auth_callback`, and proactive/on-401 token refresh.                                                                                                                                                                                | Documented behavior verified. Exact emitted registration JSON and live post-expiry renewal remain pending sanitized capture.             |
| Claude Code              | [Claude connector authentication documentation](https://claude.com/docs/connectors/building/authentication)                                                           | Uses local loopback callbacks with ephemeral ports and supports OAuth token refresh.                                                                                                                                                                                                                         | Documented behavior verified. Exact emitted registration JSON and live post-expiry renewal remain pending sanitized capture.             |

The repository must not claim named-client compatibility from source inspection or protocol fixtures
alone. A claim requires the exact released client version to complete discovery, registration,
Google sign-in, MCP access, access-token expiry, refresh rotation, and renewed MCP access against the
deployed candidate.

## Standards and implementation matrix

| Requirement                                                     | Authoritative basis                                                                                                                                                                                                                                                        | MCP-GW behavior                                                                                                                                                                                                                                                                                                                                                                               | Verification                                                                                                                                                                       |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authorization-server discovery and protected-resource discovery | [RFC 8414 §§2–3](https://www.rfc-editor.org/rfc/rfc8414.html), [RFC 9728 §§3, 5.1, 7.4, 7.6](https://www.rfc-editor.org/rfc/rfc9728.html), [MCP authorization: discovery and token audience](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization) | Advertises exact issuer, endpoints, supported grants, S256, and exact MCP resource authority.                                                                                                                                                                                                                                                                                                 | Authorization-route metadata tests and direct-client journey.                                                                                                                      |
| Dynamic public-client registration                              | [RFC 7591 §§2, 2.1, 3.1, 3.2.1, 3.2.2](https://www.rfc-editor.org/rfc/rfc7591.html), [MCP authorization: DCR](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)                                                                                | Accepts only `authorization_code` or the unordered set `authorization_code` + `refresh_token`; applies the RFC defaults `grant_types=[authorization_code]` and `response_types=[code]` when omitted; returns canonical accepted metadata and no client secret. Registrations persist by default because the response has no client-expiry signal; an explicit operator TTL remains supported. | DCR unit and SQL tests include persistence, explicit expiry, omitted-metadata defaults, the exact Codex 0.147.0/RMCP 3.0.0 shape, truthful response metadata, and rejection cases. |
| Native loopback redirect                                        | [RFC 8252 §7.3, 8.1, 8.3](https://www.rfc-editor.org/rfc/rfc8252.html), [MCP authorization: open redirection](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)                                                                                | Allows canonical HTTP loopback redirects with arbitrary ports only when the existing deployment opt-in is enabled; redirect matching remains exact after registration.                                                                                                                                                                                                                        | DCR unit tests and direct-client journey.                                                                                                                                          |
| Authorization code and PKCE                                     | [RFC 6749 §4.1, 4.1.3](https://www.rfc-editor.org/rfc/rfc6749.html), [RFC 7636 §4.2, 4.6](https://www.rfc-editor.org/rfc/rfc7636.html), [MCP authorization: code protection](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)                 | Requires authorization code, exact redirect URI, state/nonce binding, and PKCE S256; codes are one-time and short-lived.                                                                                                                                                                                                                                                                      | Broker and route tests plus direct-client journey.                                                                                                                                 |
| Resource-bound access                                           | [RFC 8707 §2.1–2.2](https://www.rfc-editor.org/rfc/rfc8707.html), [MCP authorization: resource parameter and token audience](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)                                                                 | Requires the exact canonical resource at authorization, code exchange, and refresh; emitted JWT audience remains exact.                                                                                                                                                                                                                                                                       | Broker binding tests and renewed-token runtime-authentication journey.                                                                                                             |
| Refresh grant and rotation                                      | [RFC 6749 §5.1, 5.2, 6](https://www.rfc-editor.org/rfc/rfc6749.html), [RFC 9700 §4.14.2](https://www.rfc-editor.org/rfc/rfc9700.html), [MCP authorization: token theft](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)                      | Issues a refresh credential only to a dynamic client registered for the grant. Stores only its SHA-256 digest, preserves client/principal/resource/scope binding, rotates on every use, prevents scope widening, and transactionally serializes the family before revoking every descendant on replay. Explicit client expiry caps refresh expiry.                                            | In-memory and SQL-store tests, repeated real PostgreSQL concurrent-rotation/replay smoke, route tests, and five-minute-expiry journey.                                             |
| Public client authentication                                    | [RFC 7591 §2](https://www.rfc-editor.org/rfc/rfc7591.html)                                                                                                                                                                                                                 | Requires explicit `token_endpoint_auth_method=none` because RFC 7591 otherwise defaults it to unsupported `client_secret_basic`; rejects HTTP Authorization credentials and form client secrets/assertions.                                                                                                                                                                                   | Authorization-route and DCR metadata-default tests.                                                                                                                                |
| Provider-token isolation                                        | MCP-GW two-hop security contract                                                                                                                                                                                                                                           | Never returns a Google authorization code, access token, ID token, or refresh token to the MCP client. The client refresh credential is an unrelated opaque MCP-GW credential.                                                                                                                                                                                                                | Broker and direct-client journey non-leakage assertions.                                                                                                                           |

RFC 7591 permits an authorization server to reject or replace requested client metadata and return
the metadata it actually accepted. MCP-GW implements the requested refresh grant instead of silently
downgrading it because access tokens expire after five minutes and both target client families are
documented or source-verified to refresh automatically. This keeps the registration response
truthful and avoids forcing repeated interactive Google sign-in.

RFC 7591's omitted-value defaults are applied only where compatible with this constrained public
client profile. Omitted `grant_types` and `response_types` become `authorization_code` and `code`.
The client must explicitly request `token_endpoint_auth_method=none`; accepting its omitted RFC
default would incorrectly register a confidential client using `client_secret_basic` without
issuing or supporting a client secret.

## Deliberately unchanged invariants

- Google Workspace provider grants remain server-side and encrypted.
- Google broker and internal workload-issuer principals remain issuer-qualified and distinct.
- Access-token audience is the exact configured MCP resource.
- Existing PKCE, state, nonce, authorization-code, signing-key, and issuer validation remain in
  force.
- Static and authorization-code-only clients receive no client refresh credential.
- No named client receives a special code path.

## Pending deployment evidence

The DEV change required for Codex CLI loopback testing is the following unapplied values proposal:

```yaml
googleWorkspace:
  authorizationBroker:
    dcr:
      allowLoopbackRedirects: true
      clientTtlMs: 0
```

Applying that proposal, deploying this branch, or changing DEV/GitOps requires separate approval.
During an approved Claude test, temporary sanitized registration diagnostics must record field names
and non-secret metadata needed to reproduce the request while excluding tokens, authorization
codes, PKCE verifiers, cookies, and credentials. Remove the diagnostics immediately after capture.

The final acceptance record must contain exact client versions and timestamps for:

1. Codex registration, Google sign-in, authenticated MCP call, wait beyond the five-minute access
   token lifetime, successful refresh rotation, and a second authenticated MCP call.
2. Claude registration with its exact sanitized metadata, Google sign-in, authenticated MCP call,
   wait beyond the five-minute access-token lifetime, successful refresh rotation, and a second
   authenticated MCP call.
