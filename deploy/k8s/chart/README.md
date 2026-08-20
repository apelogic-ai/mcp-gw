# mcp-gateway

Agent-agnostic remote **MCP gateway**. It puts an `agentgateway` front door in
front of one or more backend MCP servers behind a single public `/mcp` endpoint,
authenticates each caller with a bearer token (HOP-1), and only exposes a
provider's full tool catalog after that user completes the provider's OAuth
consent. The chart ships a Google Workspace MCP wrapper, an optional official
GitHub MCP backend, and per-user OAuth token storage in PostgreSQL. Every
workload is disabled by default and enabled explicitly.

## Install

The chart is published as an OCI artifact. Enabling `agentgateway` or any
authenticated wrapper requires at least one complete `hop1.issuers` entry, or
the install fails schema validation.

```bash
helm install mcp-gateway \
  oci://ghcr.io/apelogic-ai/charts/mcp-gateway \
  --version 0.2.12 \
  -f my-values.yaml
```

Minimal `my-values.yaml` for a Google Workspace deployment (replace the issuer,
audience, JWKS URL, public MCP URL, image tags, and Secret name):

```yaml
hop1:
  issuers:
    - name: workforce
      issuer: https://identity.example.com
      audiences:
        - https://mcp.example.com/mcp
      jwksUrl: https://identity.example.com/.well-known/jwks.json
      allowedAlgorithms:
        - EdDSA
      emailClaim: email
      subjectClaim: sub

agentgateway:
  enabled: true
  image:
    repository: ghcr.io/apelogic-ai/mcp-gw-agentgateway
    tag: "0.2.12"
  mcpAuthentication:
    resourceMetadata:
      resource: https://mcp.example.com/mcp
      scopesSupported:
        - openid
        - email
  backends:
    - name: google-workspace
      enabled: true
      serviceName: google-workspace
      port: 8080
      path: /mcp

googleWorkspace:
  enabled: true
  image:
    repository: ghcr.io/apelogic-ai/mcp-gw-google-workspace
    tag: "0.2.12"
  # Existing Secret supplying GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET,
  # GOOGLE_OAUTH_REDIRECT_URI, GOOGLE_TOKEN_ENCRYPTION_KEY, and TOKEN_STORE_DSN.
  secretRef:
    name: mcp-provider-runtime
```

Or override the same knobs inline:

```bash
helm install mcp-gateway oci://ghcr.io/apelogic-ai/charts/mcp-gateway \
  --version 0.2.12 \
  --set agentgateway.enabled=true \
  --set agentgateway.image.tag=0.2.12 \
  --set googleWorkspace.enabled=true \
  --set googleWorkspace.image.tag=0.2.12 \
  --set googleWorkspace.secretRef.name=mcp-provider-runtime \
  --set-json 'hop1.issuers=[{"name":"workforce","issuer":"https://identity.example.com","audiences":["https://mcp.example.com/mcp"],"jwksUrl":"https://identity.example.com/.well-known/jwks.json","allowedAlgorithms":["EdDSA"],"emailClaim":"email","subjectClaim":"sub"}]'
```

Runtime secrets are referenced as **existing** Kubernetes Secrets. Create them
from your own secret manager; the chart never generates credentials or embeds a
DSN, OAuth secret, or token encryption key in rendered manifests.

Direct-client authorization is separately opt-in under
`googleWorkspace.authorizationBroker`. The typed values require a public HTTPS
issuer, exact MCP resource, Google callback, active public key ID, scopes, and
either constrained DCR or at least one static public client. The signing JWKS is
never a values or environment value: `signingKeyring.secretKeyRef` selects one
key from an existing Secret, and the chart projects it read-only at
`/var/run/secrets/mcp-gateway/broker/signing-jwks.json`. Broker mode also
requires the AgentGateway public Ingress and Google backend. The chart routes
the exact metadata/authorize/token/register/JWKS/callback paths to the wrapper,
keeps the MCP resource behind AgentGateway, and adds the broker issuer's public
RS256 JWKS to AgentGateway trust automatically. The issuer, resource, callback,
and Ingress host must describe one coherent public HTTPS origin. See
`deploy/k8s/examples/values-oauth-broker.example.yaml` in the source repository.
`ingressControllerPeer` must contain non-empty namespace and pod label selectors
for the installed Ingress controller; the NetworkPolicy admits that exact peer
and AgentGateway separately, without making the wrapper Service cluster-wide.

Broker values fail before deployment when they would fail the runtime contract.
Chart-managed issuer/resource/callback URLs must use one canonical, public-DNS
or public-IPv4 HTTPS origin, omit credentials/query/fragment/custom ports, and
use unambiguous non-trailing paths. WHATWG numeric IPv4 aliases (including
hexadecimal, octal, shortened, and mixed spellings) and special-use IPv4 blocks
are rejected rather than normalized. Generated discovery, authorization, token,
registration, JWKS, callback, MCP, protected-resource metadata, and private
provider-control paths cannot collide. Static client IDs match
`^[A-Za-z0-9._~-]{8,200}$`; redirects and client metadata URLs are bounded,
credential-free public HTTPS URLs (or explicitly enabled canonical HTTP
loopback redirects), and client scopes must be a subset of the broker's
comma-free OAuth scope-token allowlist. Trusted proxy addresses are exact,
normalized IP literals, not names or forwarding chains. DCR numeric limits may
not exceed JavaScript's safe-integer maximum. Broker mode also rejects a direct
Google HOP-1 issuer because broker and direct Google identities are distinct
runtime modes.

When provider consent uses the shared PostgreSQL token store, enable
`oauthMigrations` and point `oauthMigrations.secretKeyRef` at a Secret key
holding `TOKEN_STORE_DSN`. The pre-install/pre-upgrade hook runs the OAuth schema
migrations under an advisory lock.

## Minimal values

The smallest valid configuration is one `hop1.issuers` entry plus one enabled
workload. Pin every image with `image.tag` or `image.digest`; the defaults ship
with an empty tag. Set `agentgateway.mcpAuthentication.resourceMetadata.resource`
to your public MCP URL and keep `scopesSupported` aligned with the wrapper's
identity scopes (`openid`, `email` by default). Expose the endpoint by enabling
`agentgateway.ingress` or fronting the ClusterIP Service with your own gateway.

## Upgrade

```bash
helm upgrade mcp-gateway \
  oci://ghcr.io/apelogic-ai/charts/mcp-gateway \
  --version <new-version> \
  -f my-values.yaml
```

## Uninstall

```bash
helm uninstall mcp-gateway
```

Externally managed Secrets and the PostgreSQL data are not owned by the release
and are left in place.

## Key values

| Key                                                               | Default                                             | Description                                                                                   |
| ----------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `hop1.issuers`                                                    | `[]`                                                | HOP-1 bearer-token issuers. At least one full entry is required when any workload is enabled. |
| `agentgateway.enabled`                                            | `false`                                             | Deploy the `/mcp` front door.                                                                 |
| `agentgateway.image.tag`                                          | `""`                                                | Agentgateway image tag (or set `image.digest`).                                               |
| `agentgateway.mcpAuthentication.resourceMetadata.resource`        | `""`                                                | Public MCP URL advertised in protected-resource metadata.                                     |
| `agentgateway.backends`                                           | Google Workspace, db-mcp, github-mcp (all disabled) | Backend routing targets behind the shared endpoint.                                           |
| `agentgateway.ingress.enabled`                                    | `false`                                             | Expose `/mcp` and the protected-resource metadata path via Ingress.                           |
| `googleWorkspace.enabled`                                         | `false`                                             | Deploy the Google Workspace MCP wrapper.                                                      |
| `googleWorkspace.secretRef.name`                                  | `""`                                                | Existing Secret with the wrapper's OAuth and token-store env.                                 |
| `googleWorkspace.authorizationBroker.enabled`                     | `false`                                             | Enable the public authorization broker and its typed fail-closed configuration.               |
| `googleWorkspace.authorizationBroker.signingKeyring.secretKeyRef` | empty                                               | Existing Secret name/key projected as the private signing keyring file.                       |
| `googleWorkspace.policy.enabled`                                  | `false`                                             | Enforce a YAML Google Workspace tool policy.                                                  |
| `githubWrapper.enabled`                                           | `false`                                             | Deploy the GitHub MCP credential wrapper.                                                     |
| `githubMcp.enabled`                                               | `false`                                             | Deploy the bundled official GitHub MCP server backend.                                        |
| `dbMcp.enabled`                                                   | `false`                                             | Deploy the database MCP backend.                                                              |
| `oauthMigrations.enabled`                                         | `false`                                             | Run OAuth token-store schema migrations as a Helm hook.                                       |
| `postgresql.caBundle.enabled`                                     | `false`                                             | Project a private CA bundle into wrappers and the migration job for TLS to PostgreSQL.        |
| `productionProfile.enabled`                                       | `false`                                             | Validate that the full provider bundle is enabled explicitly.                                 |

See `docs/quickstart.md` in the source repository for the end-to-end install,
setup, and client-connection walkthrough.
