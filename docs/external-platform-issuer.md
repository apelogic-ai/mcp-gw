# External Governing Platform Integration

Status: public deployment contract

MCP-GW can accept workload tokens minted by an external governing platform,
delegate provider tool decisions to that platform's policy service, and expose
authenticated provider connection lifecycle routes to selected in-cluster
callers. The public chart keeps each part opt-in and does not create a public
route for connection start, status, refresh, or disconnect.

Start with
[`values-external-platform-issuer.example.yaml`](../deploy/k8s/examples/values-external-platform-issuer.example.yaml)
and replace its illustrative coordinates in a private values overlay.

## HOP-1 issuer contract

Configure the platform's token issuer under `hop1.issuers`. The configured
values must describe the tokens that reach MCP-GW:

- `issuer` must exactly match the token's `iss` claim.
- Every accepted token must contain one of the configured `audiences`. A fixed
  workload audience such as `mcp-gateway-workload` is valid and does not need
  to equal the public MCP resource URL.
- `allowedAlgorithms` is an explicit allowlist. Include `EdDSA` when the
  platform signs workload tokens with Ed25519 keys.
- `jwksUrl` must publish the corresponding public verification keys.
- `emailClaim` supplies the bound email attribute; `subjectClaim` should name
  an immutable principal identifier.
- When configured, `introspection.url` is checked with the credential selected
  by `introspection.credentialSecretKeyRef`. The chart reads that key from an
  existing Secret and projects it into AgentGateway and both wrappers without
  putting its value in Helm values.

The public MCP resource remains
`agentgateway.mcpAuthentication.resourceMetadata.resource`. It is independent
from the token audience unless the issuer deliberately uses the same string
for both.

Provider credentials are stored under:

```text
provider + hop1_issuer + hop1_subject
```

The governing platform must therefore present the same stable `(iss, sub)` for
provider authorization, status, disconnect, and later MCP tool calls. Changing
either claim selects a different provider connection.

For GitHub connections, the resolved `emailClaim` value must case-insensitively
match one of the user's verified GitHub email addresses. This is an identity
binding, not merely display metadata: GitHub OAuth consent cannot connect a
different account to the governing principal. On a mismatch, MCP-GW consumes
the one-time OAuth state, revokes the issued credential (or retains it for
cleanup retry), activates no connection, and reports the `identity_mismatch`
diagnostic category. Operators should correct the governing-platform login
email or add and verify that address in GitHub before starting a new consent
flow.

## External policy endpoint

Set the chart-wide typed value `policy.opaUrl` to one OPA-compatible decision
endpoint:

```yaml
policy:
  opaUrl: http://policy.governing-platform.svc:8181/v1/data/mcp/allow
```

The chart injects `OPA_POLICY_URL` into both authenticated provider wrappers.
An in-cluster endpoint may use HTTP; a remote endpoint should use HTTPS.
Credentials in the URL and URL fragments are rejected. The typed value cannot
be combined with wrapper `env`, `extraEnv`, or selected Secret keys that also
set `OPA_POLICY_URL`, preventing ambiguous duplicate environment variables.

Existing deployments may continue to configure `OPA_POLICY_URL` through the
wrapper-specific free-form environment fields while `policy.opaUrl` is empty.
Move both wrappers to the typed value together when adopting this contract.

## GitHub post-consent return origins

Allow the browser to return to selected platform UI origins after GitHub
consent with `githubWrapper.oauth.redirectAfterAllowedOrigins`:

```yaml
githubWrapper:
  oauth:
    redirectAfterAllowedOrigins:
      - https://portal.platform.example
      - http://127.0.0.1:8765
```

Entries are origins, not callback URLs: do not include a path, query, fragment,
credentials, or wildcard host. HTTPS is required except for explicit
`127.0.0.1` and `[::1]` HTTP loopback origins. The provider OAuth callback
remains the separately configured MCP-GW callback. At runtime, the requested
`redirectAfter` URL must match one of the allowed origins.

The typed list maps to
`GITHUB_OAUTH_REDIRECT_AFTER_ALLOWED_ORIGINS`. It cannot be combined with a
free-form value for that environment variable. Legacy free-form configuration
remains accepted while the typed list is empty.

## Private connection lifecycle calls

Set `connectionLifecycle.allowedCallers` to the governing workload's Namespace
and, where possible, Pod labels:

```yaml
connectionLifecycle:
  enabled: true
  allowedCallers:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: governing-platform
      podSelector:
        matchLabels:
          app.kubernetes.io/name: connections-bridge
```

This adds only NetworkPolicy ingress peers to the existing wrapper ClusterIP
Services. It creates no Ingress or HTTPRoute. Call the canonical internal
routes `/connections/{provider}/{authorize,status,refresh,disconnect}` with the user's HOP-1
bearer token. Network reachability never bypasses token validation, principal
binding, policy, or lifecycle generation guards.

Provider callback routes are a separate public return surface. Do not expose a
broad `/oauth` or `/connections` prefix merely to support the governing
platform.

## Private CA trust

If the issuer JWKS, introspection endpoint, or HTTPS policy service uses a
private CA, enable `trustBundle` and reference one existing ConfigMap or Secret
key. The chart mounts it into AgentGateway and both wrappers. AgentGateway uses
the file as its complete root set, so it must contain every public and private
root AgentGateway needs—not only the private delta.

```yaml
trustBundle:
  enabled: true
  configMapKeyRef:
    name: governing-platform-trust
    key: ca-bundle.pem
```

Do not place CA contents, introspection credentials, provider OAuth secrets,
token encryption keys, or database DSNs in the public values file.

## Deployment checklist

1. Create the referenced runtime Secrets and optional trust ConfigMap.
2. Run the OAuth schema migration hook by enabling `oauthMigrations` whenever
   the wrappers use the shared PostgreSQL token store.
3. Verify the issuer, audience, algorithm, JWKS, and optional introspection
   coordinates against a real workload token without logging the token.
4. Confirm the caller Namespace and Pod labels before setting
   `connectionLifecycle.allowedCallers`.
5. Render the private overlay and verify that one `OPA_POLICY_URL` appears in
   each wrapper and one GitHub allowed-origin value appears in the GitHub
   wrapper.
6. Test provider authorization and the subsequent MCP call with the same HOP-1
   `(iss, sub)` identity.
