# Direct-Client OAuth Contract

Status: source contract; live-client compatibility requires separate evidence

This contract covers public remote MCP clients that authenticate directly to MCP-GW. Google is an
upstream sign-in provider for this flow; it is not the MCP resource's authorization server.
MCP-GW issues a short-lived access token whose issuer is the MCP-GW authorization-server identity
and whose audience is the exact canonical MCP resource URI.

Downstream Google Workspace and GitHub authorization is a separate provider-consent flow. Provider
credentials remain inside MCP-GW and are keyed by the exact `(issuer, subject)` gateway principal.

## Client and registration matrix

| Client or mode                                                                                     | Registration                                                   | Evidence and support statement                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Repository protocol fixture                                                                        | Static client and constrained DCR                              | Covered by automated authorization-code, PKCE, DCR, token, and provider-conformance tests. This proves the protocol contract, not a third-party client UI.                                                                                                               |
| Pre-registered public client                                                                       | Static client                                                  | Supported when its exact redirect URIs and allowed scopes are configured by the operator. It receives no client secret.                                                                                                                                                  |
| Dynamically registered public client                                                               | Constrained DCR                                                | Supported only when the deployment advertises and enables `/register`. Authorization code, `token_endpoint_auth_method=none`, and PKCE S256 are mandatory. Redirect URIs are immutable after registration and must pass the deployment's HTTPS/explicit-loopback policy. |
| Claude remote connector                                                                            | Static client or constrained DCR, depending on client behavior | Not yet claimed as tested against this broker release. Add an exact client version and evidence before declaring support.                                                                                                                                                |
| Codex remote connector                                                                             | Static client or constrained DCR, depending on client behavior | Not yet claimed as tested against this broker release. Add an exact client version and evidence before declaring support.                                                                                                                                                |
| Trusted enterprise control plane                                                                   | Existing trusted HOP-1 bearer-token path                       | Supported as a distinct configured issuer. This is resource-server compatibility, not direct-client registration and not cross-issuer account linking.                                                                                                                   |
| Confidential clients, implicit grants, password grants, device flow, arbitrary grants/auth methods | Not supported                                                  | The first broker release does not issue client secrets or accept these flows.                                                                                                                                                                                            |
| Client-ID Metadata Documents                                                                       | Not supported in the first broker release                      | Do not advertise or infer CIMD support unless a later reviewed implementation applies the same redirect and SSRF policy.                                                                                                                                                 |

The tested matrix is deliberately conservative. A protocol fixture cannot establish that a specific
Claude, Codex, or other third-party release correctly performs discovery, DCR, PKCE, reconnect, or
tool refresh behavior.

## Direct authorization and renewal

The direct-client authorization flow is:

1. Discover protected-resource and authorization-server metadata from the public MCP origin.
2. Use a pre-registered public client or constrained DCR when the registration endpoint is
   advertised.
3. Start authorization with `response_type=code`, an exact registered redirect URI, the exact MCP
   `resource`, and PKCE S256.
4. MCP-GW performs upstream Google sign-in using a separate one-time transaction and nonce.
5. Exchange the one-time broker authorization code at `/token` with the same client, redirect,
   resource, and PKCE verifier.
6. Send the broker-issued bearer token only to the exact MCP resource.

Client `state`, broker-to-Google CSRF state, and the broker authorization code are three independent
values. Google authorization codes and Google access, ID, or refresh tokens are never returned to
the MCP client.

The first broker release issues no public refresh token. When the short-lived MCP access token
expires, the client must repeat the complete authorization-code flow with a new PKCE verifier and
new one-time state. A client may benefit from an existing Google browser session, but MCP-GW still
performs and verifies a fresh authorization transaction.

## Public route boundary

Only the following remote-client surface belongs on the public MCP ingress:

| Route                                                      | Public behavior                                                                                                                          |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `/mcp`                                                     | MCP resource; broker-issued and configured trusted-issuer HOP-1 bearer tokens are validated for the exact resource audience.             |
| `/.well-known/oauth-protected-resource/mcp`                | Protected-resource metadata for the canonical MCP resource.                                                                              |
| Authorization-server metadata route from the broker issuer | Advertises `/authorize`, `/token`, the current `jwks_uri`, supported PKCE methods, and `/register` only when constrained DCR is enabled. |
| `/authorize`                                               | Direct-client authorization-code entry point.                                                                                            |
| `/token`                                                   | Authorization-code exchange; no public refresh-token grant.                                                                              |
| `/register`                                                | Public only when constrained DCR is enabled and advertised.                                                                              |
| The `jwks_uri` advertised by authorization-server metadata | Public verification keys only; never signing keys.                                                                                       |
| `/oauth/google/broker/callback`                            | State- and nonce-bound callback for the broker's upstream Google sign-in. It is not a provider-control API.                              |

Provider callbacks such as `/oauth/google/callback` and `/oauth/github/callback` are HOP-2
provider return endpoints. A deployment may expose them specifically for its configured provider
apps, but they are not direct-client OAuth endpoints and must enforce one-time provider state.

The following authenticated handlers are private control-plane APIs and must not be included in the
public MCP ingress or advertised in authorization-server metadata:

```text
/oauth/google/start
/oauth/google/status
/oauth/google/disconnect
/oauth/github/start
/oauth/github/status
/oauth/github/disconnect
```

Remote MCP clients use the authenticated `google_oauth_*` and `github_oauth_*` MCP tools for this
lifecycle. Internal portals may call the equivalent HTTP handlers only through a private route with
a valid HOP-1 bearer token.

## Principal and provider conformance

The credential key is always:

```text
provider + hop1_issuer + hop1_subject
```

An MCP-GW broker token and a configured trusted-issuer token with the same email remain different
principals when their issuer or subject differs. Email is display and provider-account verification
data; it is not an account-linking key.

Before consent, each provider wrapper advertises only its status/start helpers. After a provider
grant is stored for that exact principal, the wrapper advertises its helpers plus the approved
provider catalog. A Google grant does not unlock GitHub tools and a GitHub grant does not unlock
Google tools.

## Versioned GitOps handoff

A GitOps consumer must receive one immutable release handoff containing:

- the MCP-GW SemVer and source commit;
- OCI chart digest and every first-party image digest;
- the canonical public MCP resource and authorization-server issuer;
- the public route set, with DCR enabled/disabled recorded explicitly;
- broker token lifetime, signing algorithm, active public key ID, and allowed verification-key
  overlap, without private signing material;
- the static-client or constrained-DCR mode and the exact live-client compatibility evidence; and
- the required provider callback paths and private control-plane route exclusions.

The source contract and test fixtures do not authorize a deployment or release. GitOps promotion
must consume a separately approved, versioned release rather than an untagged branch or mutable
image tag.

## Wrapper runtime configuration

The Google wrapper hosts the broker when `MCP_BROKER_ENABLED=true`. Its source-level configuration
contract is:

| Variable                           | Meaning                                                                                   |
| ---------------------------------- | ----------------------------------------------------------------------------------------- |
| `MCP_AUTHORIZATION_ISSUER`         | Canonical public HTTPS authorization-server issuer.                                       |
| `MCP_RESOURCE_URI`                 | Exact canonical public MCP resource URI used as every broker token's audience.            |
| `MCP_BROKER_GOOGLE_REDIRECT_URI`   | Exact public `/oauth/google/broker/callback` URI registered with Google.                  |
| `MCP_BROKER_SIGNING_JWKS_FILE`     | Mounted JWKS containing the active private RSA key and optional previous public keys.     |
| `MCP_BROKER_ACTIVE_KID`            | `kid` selecting the active private `RS256`, `use=sig` key.                                |
| `MCP_BROKER_SCOPES`                | Broker scope allowlist; defaults to `mcp`.                                                |
| `MCP_OAUTH_STATIC_CLIENTS_JSON`    | JSON array of immutable public clients, exact redirect URIs, and allowed scopes.          |
| `MCP_DCR_ENABLED`                  | Advertises and enables constrained DCR when `true`.                                       |
| `MCP_DCR_ALLOW_LOOPBACK_REDIRECTS` | Explicit opt-in for native-client HTTP loopback redirects; public HTTPS remains required. |

Optional positive-integer DCR bounds are `MCP_DCR_CLIENT_TTL_MS`, `MCP_DCR_MAX_CLIENTS`,
`MCP_DCR_MAX_RATE_KEYS`, `MCP_DCR_RATE_LIMIT`, and `MCP_DCR_RATE_WINDOW_MS`. Broker state,
authorization codes, registrations, and rate limits share the existing `TOKEN_STORE_DSN`
PostgreSQL database. The signing file is a secret mount, never an environment value or ConfigMap.

When the broker is enabled, a direct Google issuer profile is rejected at startup. The broker's
own issuer is added to the wrapper's trusted HOP-1 profiles, while any separately configured
enterprise issuer remains a distinct `(issuer, subject)` principal.
