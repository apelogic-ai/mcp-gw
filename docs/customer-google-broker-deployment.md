# Customer Google SSO, Workspace MCP, and DCR Deployment

This runbook deploys MCP-GW as a Google-only external MCP destination. It is
intended for clients that discover `https://mcp.<customer-domain>/mcp`, sign in
with Google, and use Google Workspace tools. It does not enable GitHub.

The OAuth broker is the external MCP authorization server. Google authenticates
the user upstream; MCP-GW verifies that identity and issues its own short-lived
MCP access token. Google access and refresh tokens remain encrypted server-side
for Workspace tool execution and are never returned to the MCP client.

## Identity model

For a Google-only deployment, omit `hop1.issuers`. With
`googleWorkspace.authorizationBroker.enabled=true`, the chart automatically
adds the broker issuer to AgentGateway trust.

The chart also creates `<release>-authorization-broker`, a provider-neutral
ClusterIP Service for broker routes. Public OAuth metadata still advertises the
public HTTPS JWKS URI, while in-cluster verifiers retrieve those keys through
this role Service rather than the Google Workspace Service name.

If the same endpoint must also accept internal workload tokens, add a real
issuer profile under `hop1.issuers`. It coexists with the broker, but it is a separate `(issuer, subject)`
principal even when email values match. Do not configure
`https://accounts.google.com` as a direct HOP-1 issuer in broker mode.

The chart keeps every configured issuer as an authentication provider, but it explicitly selects
the broker as the sole public discovery authority. Protected-resource metadata therefore advertises
only the public broker issuer; it never leaks an internal service URL. The generated AgentGateway
field is `resourceMetadata.authorizationServers`, serialized on the wire as
`authorization_servers`.

## Inputs owned by the customer

The customer GitOps repository owns these deployment coordinates:

- public host, broker issuer, MCP resource, and exact Google broker callback;
- image digests from the immutable MCP-GW release handoff;
- PostgreSQL DSN and Google OAuth provider credentials, stored in existing
  Kubernetes Secrets;
- a private RSA `RS256` signing JWKS stored as one selected Secret key, plus its
  non-secret active `kid` value;
- selected Google Workspace provider scopes and wrapper policy;
- whether constrained DCR is enabled, its limits, and its trusted-proxy policy;
- exactly one broker ingress-source model described below.

The chart never accepts broker secrets through values or generic environment
variables. Do not place the PostgreSQL DSN, Google client secret, token
encryption key, or JWKS payload in a values file, ConfigMap, or Helm command
line.

## Required existing Secrets

Create the Secrets through the customer's approved secret manager integration.
The names and keys below are examples, not product constants.

| Secret                  | Required keys                                                                                                                         | Consumed by                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `mcp-gw-oauth-db`       | `TOKEN_STORE_DSN`                                                                                                                     | migration hook and Google wrapper |
| `mcp-gw-google-runtime` | `TOKEN_STORE_DSN`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`, `GOOGLE_TOKEN_ENCRYPTION_KEY` | Google wrapper                    |
| `mcp-gw-broker-signing` | `signing-jwks.json`                                                                                                                   | broker signing keyring file mount |

`signing-jwks.json` is a JWKS object with a `keys` array. The key selected by
`activeSigningKid` is a private RSA signing key with `kty=RSA`, `alg=RS256`,
`use=sig`, and a unique `kid`. Keep a previous public verification key during
rotation overlap. The chart projects only this one Secret key as a read-only
`0440` file and sets `MCP_BROKER_SIGNING_JWKS_FILE`; no signing bytes appear in
the workload environment.

## Google Cloud configuration

Create a customer-owned Google OAuth application and configure only MCP-GW
callback URIs. For host `mcp.customer.example`, register:

```text
https://mcp.customer.example/oauth/google/broker/callback
https://mcp.customer.example/oauth/google/callback
```

The first callback is the external broker's Google identity return. The second
is the Google Workspace provider-consent return. It is intentionally exposed by
the separate exact-path provider callback manifest; do not publish the
authenticated `/oauth/google/start`, `/status`, or `/disconnect` control paths.
Enable the required Google APIs and request only the Workspace scopes approved
by the customer policy.

## Helm values

Start from
`deploy/k8s/examples/values-customer-google-broker.example.yaml`. Replace all
placeholder domain/client values and pin all images to the immutable release
digest. The essential broker shape is:

```yaml
# No hop1.issuers: the broker is the sole external HOP-1 issuer.
agentgateway:
  enabled: true
  mcpAuthentication:
    resourceMetadata:
      resource: https://mcp.customer.example/mcp
      scopesSupported: [mcp]
  ingress:
    enabled: true
    host: mcp.customer.example

googleWorkspace:
  enabled: true
  authorizationBroker:
    enabled: true
    issuer: https://mcp.customer.example/oauth
    resource: https://mcp.customer.example/mcp
    googleCallbackUri: https://mcp.customer.example/oauth/google/broker/callback
    activeSigningKid: customer-key-2026-09
    scopes: [mcp]
    signingKeyring:
      secretKeyRef:
        name: mcp-gw-broker-signing
        key: signing-jwks.json
    dcr:
      enabled: true
```

The chart enforces canonical public HTTPS URLs and requires the issuer,
resource, callback, and Ingress host to share one origin. It also requires the
Google Workspace backend, chart-managed AgentGateway Ingress, database migration
hook, and a complete signing-key Secret reference.

## Choose one ingress-source model

Broker routes are public, but the Google wrapper Service stays protected by a
NetworkPolicy. Configure exactly one of these models. The chart fails rendering
for zero, partial, or mixed sources.

For an in-cluster reverse proxy, provide both selector pairs:

```yaml
googleWorkspace:
  authorizationBroker:
    ingressControllerPeer:
      namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: ingress-nginx
      podSelector:
        matchLabels:
          app.kubernetes.io/component: controller
    ingressSourceCidrs: []
```

For an ALB or other IP-target data plane, leave the selectors empty and provide
the trusted source CIDRs observed at the Google wrapper Pod. They are not the
public client address range. Do not use `0.0.0.0/0`.

```yaml
googleWorkspace:
  authorizationBroker:
    ingressControllerPeer:
      namespaceSelector:
        matchLabels: {}
      podSelector:
        matchLabels: {}
    ingressSourceCidrs:
      - 10.0.0.0/8 # replace with the customer's actual ALB/VPC source CIDR
```

Apply the accompanying exact provider-callback Ingress/NetworkPolicy manifest
from `deploy/k8s/examples/google-provider-callback.example.yaml`, using the
same ingress-source model. It is an additive policy only for
`/oauth/google/callback`.

## DCR or static registration

For direct clients that support Dynamic Client Registration, set
`googleWorkspace.authorizationBroker.dcr.enabled=true`. The deployment then
advertises and exposes `/oauth/register` (for the issuer above). Registration
is intentionally constrained: public clients only, no client secret, PKCE S256,
immutable HTTPS redirect URIs unless explicit canonical loopback support is
enabled, and deployment-owned rate/size/count limits.

For named-client rollout instead, set DCR to false and configure at least one
immutable public client under `staticClients`. The chart fails if neither mode
is selected. A client secret is never used for either mode.

## Deployment and validation

Run the customer's normal GitOps reconciliation after secrets, values, and the
provider-callback manifest are committed. Before exposing the endpoint, verify:

```bash
curl -fsS https://mcp.customer.example/.well-known/oauth-protected-resource/mcp
curl -fsS https://mcp.customer.example/.well-known/oauth-authorization-server/oauth
curl -fsS https://mcp.customer.example/oauth/.well-known/jwks.json
```

When DCR is enabled, authorization-server metadata must advertise a
`registration_endpoint`; it must not be present in static-only mode. Verify a
browser authorization-code + PKCE flow with a test public client, then call the
MCP endpoint using the issued broker token. Finally, initiate Google Workspace
provider consent through the authenticated MCP tool `google_oauth_start`,
complete the provider callback, and confirm a read-only Workspace tool call
succeeds for the same issuer-qualified principal.

Named third-party client compatibility must be recorded with the exact client
version and observed journey. The shipped protocol tests prove the broker
contract, not compatibility with a particular Claude, Codex, or other client
release.
