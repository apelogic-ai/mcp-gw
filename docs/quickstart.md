# Quickstart

Get the MCP gateway running, wire up identity and provider OAuth, and connect an
MCP client. The gateway exposes one public `/mcp` endpoint. Callers authenticate
with a bearer token (HOP-1); each downstream provider's full tool catalog stays
hidden until the user completes that provider's OAuth consent.

Two credential hops:

- **HOP-1 (client to gateway):** the MCP client presents a bearer token from an
  issuer you configure (Google OIDC, Okta, Entra, or a purpose-built identity
  service). It identifies the caller and is never forwarded downstream.
- **HOP-2 (wrapper to Google):** the Google Workspace wrapper mints short-lived
  Google access tokens from a per-user refresh token stored under the HOP-1
  principal.

---

## 1. Install

### Path A — local Docker Compose (evaluation)

```bash
cp deploy/compose/.env.example deploy/compose/.env
# edit deploy/compose/.env, then:
docker compose -f deploy/compose/docker-compose.yaml up
```

Compose starts three services: `agentgateway` (published on `GATEWAY_PORT`,
default `8080`), the `google-workspace` wrapper, and a `token-store` PostgreSQL
instance seeded with the OAuth schema. The gateway serves MCP at
`http://localhost:8080/mcp`.

Fill in at least these `.env` values before starting (see [Setup](#2-setup) for
what each one is):

```dotenv
# HOP-1 caller identity (single-issuer form)
HOP1_ISSUER=https://identity.example.com
HOP1_JWKS_URL=https://identity.example.com/.well-known/jwks.json
HOP1_AUDIENCE=https://mcp.example.com/mcp
HOP1_ALLOWED_ALGORITHMS=EdDSA

# Google Workspace OAuth consent app (HOP-2)
GOOGLE_OAUTH_CLIENT_ID=<google-oauth-client-id>
GOOGLE_OAUTH_CLIENT_SECRET=<google-oauth-client-secret>
GOOGLE_OAUTH_REDIRECT_URI=https://mcp.example.com/oauth/google/callback

# 32 random bytes, base64 (openssl rand -base64 32)
GOOGLE_TOKEN_ENCRYPTION_KEY=<base64-32-bytes>

# Token store DSN (default points at the bundled postgres service)
TOKEN_STORE_DSN=postgres://mcp:mcp@token-store:5432/mcp
```

For multiple issuers use `HOP1_ISSUERS_JSON` instead of the single `HOP1_*`
fields; see the commented example in `deploy/compose/.env.example`. To also run
the GitHub MCP backend locally, use the `deploy/compose/docker-compose.github-mcp.yaml`
overlay and fill the `GITHUB_*` values.

### Path B — Kubernetes via Helm (OCI)

The chart is disabled by default and validated against a JSON schema: enabling
any workload requires at least one complete `hop1.issuers` entry.

```bash
helm install mcp-gateway \
  oci://ghcr.io/apelogic-ai/charts/mcp-gateway \
  --version 0.2.12 \
  -f my-values.yaml
```

Minimal `my-values.yaml` for Google Workspace:

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
  secretRef:
    name: mcp-provider-runtime

# Run OAuth schema migrations against the token store
oauthMigrations:
  enabled: true
  secretKeyRef:
    name: mcp-oauth-database
    key: dsn
```

Verify:

```bash
helm upgrade --install mcp-gateway oci://ghcr.io/apelogic-ai/charts/mcp-gateway \
  --version 0.2.12 -f my-values.yaml
kubectl rollout status deploy/mcp-gateway-agentgateway
```

The agentgateway Service is `ClusterIP` by default. Reach `/mcp` by enabling
`agentgateway.ingress`, fronting the Service with your own gateway, or during
testing with `kubectl port-forward svc/mcp-gateway-agentgateway 8080:8080`.

---

## 2. Setup

### HOP-1 issuer (bearer-token identity)

Every enabled workload validates inbound bearer tokens against `hop1.issuers`.
Each entry needs an issuer URL, at least one audience, a JWKS URL, and a non-empty
algorithm allowlist. The audience should be your public MCP URL.

```yaml
hop1:
  issuers:
    - name: workforce
      issuer: https://identity.example.com
      audiences:
        - https://mcp.example.com/mcp
      jwksUrl: https://identity.example.com/.well-known/jwks.json
      allowedAlgorithms:
        - EdDSA # RS256/384/512, PS*, ES256/384, or EdDSA
      discoverable: true # advertise in protected-resource metadata
      emailClaim: email
      subjectClaim: sub
```

For issuers that require immediate revocation, add an `introspection` block with
a `url` and a `credentialSecretKeyRef` pointing at an existing Secret key. A full
multi-issuer example is in
[`deploy/k8s/examples/values-enterprise-contract.example.yaml`](../deploy/k8s/examples/values-enterprise-contract.example.yaml).
Keep `agentgateway.mcpAuthentication.resourceMetadata.resource` set to the public
MCP URL and `scopesSupported` aligned with the wrapper identity scopes (`openid`,
`email` by default). Use an immutable `subjectClaim` where possible.

### Google OAuth client (HOP-2)

Create a Google OAuth client (web application) and set its authorized redirect
URI to `https://<your-mcp-host>/oauth/google/callback`. The wrapper reads these
from environment:

```dotenv
GOOGLE_OAUTH_CLIENT_ID=<google-oauth-client-id>
GOOGLE_OAUTH_CLIENT_SECRET=<google-oauth-client-secret>
GOOGLE_OAUTH_REDIRECT_URI=https://mcp.example.com/oauth/google/callback
GOOGLE_TOKEN_ENCRYPTION_KEY=<base64-32-bytes>   # openssl rand -base64 32
```

On Kubernetes, put these (plus `TOKEN_STORE_DSN`) in an existing Secret and
reference it with `googleWorkspace.secretRef.name`. The chart never creates these
credentials. Leave `GOOGLE_OAUTH_SCOPES` unset to keep the full generated consent
scope set; narrowing it disables the `gws_*` tools whose scopes it drops.

### Token store (PostgreSQL)

Per-user refresh tokens are stored encrypted in PostgreSQL, keyed by
`provider + hop1_issuer + hop1_subject`. Provide a DSN via `TOKEN_STORE_DSN`.

- **Compose:** the bundled `token-store` service is seeded from
  `servers/google-workspace/config/oauth-schema.sql`; the default DSN
  `postgres://mcp:mcp@token-store:5432/mcp` works out of the box.
- **Kubernetes:** point `TOKEN_STORE_DSN` (inside the provider Secret) at your
  database and enable `oauthMigrations` with a `secretKeyRef` to a Secret key
  holding the DSN. The pre-install/pre-upgrade hook applies the schema under an
  advisory lock. When the database uses a private CA, configure
  `postgresql.caBundle` with exactly one existing `ConfigMap` or `Secret` key.

### Optional backends

- **GitHub MCP:** enable `githubWrapper` and `githubMcp`, add the `github-mcp`
  backend, and register a GitHub OAuth app with callback
  `https://<your-mcp-host>/oauth/github/callback`. Start from
  [`deploy/k8s/examples/values-github-mcp.example.yaml`](../deploy/k8s/examples/values-github-mcp.example.yaml).
- **Google Workspace tool policy:** enable `googleWorkspace.policy` with inline
  YAML. See
  [`deploy/k8s/examples/values-google-policy.example.yaml`](../deploy/k8s/examples/values-google-policy.example.yaml).
- **Full production bundle:** see
  [`deploy/k8s/examples/values-production-bundle.example.yaml`](../deploy/k8s/examples/values-production-bundle.example.yaml).

---

## 3. Use

Point any MCP client that speaks Streamable HTTP at the public endpoint and send
a HOP-1 bearer token on every request:

```http
POST https://mcp.example.com/mcp
Authorization: Bearer <hop1-user-token>
Content-Type: application/json
Mcp-Protocol-Version: 2025-06-18
```

Clients that support MCP OAuth protected-resource discovery can obtain the token
themselves from the advertised metadata at
`/.well-known/oauth-protected-resource/mcp`. Others should be handed a token
minted by your identity provider for the MCP audience.

### Connect on first use

Before a provider is connected, its wrapper advertises **only** its connection
helpers on `tools/list`:

```text
google_oauth_status   google_oauth_start
github_oauth_status   github_oauth_start   # when the GitHub backend is enabled
```

1. Call `google_oauth_status` to check whether the caller is connected and which
   scopes are missing.
2. Call `google_oauth_start` to get an `authorizationUrl`. Open it, approve the
   Google consent screen, and return.
3. On the next `tools/list`, the wrapper advertises its helpers **plus** the full
   Google Workspace tool catalog (`google_*` curated tools, generated `gws_*`
   tools, and the `google_workspace_gws` passthrough) for that same HOP-1
   principal.

Provider grants are never inferred from the HOP-1 login: every provider is
gated by its own consent. Use the same stable HOP-1 subject for connect, status,
and later tool calls. Headless clients and portals can drive the equivalent HTTP
routes (`/oauth/<provider>/start`, `/status`, `/disconnect`) directly with a
trusted HOP-1 token; see
[`provider-connection-flows.md`](provider-connection-flows.md) and the
[`client-integration-runbook.md`](client-integration-runbook.md).
