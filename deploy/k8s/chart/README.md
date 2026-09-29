# mcp-gateway

Agent-agnostic remote **MCP gateway**. It puts an `agentgateway` front door in
front of one or more backend MCP servers behind a single public `/mcp` endpoint,
authenticates each caller with a bearer token (HOP-1), and exposes each enabled
provider's stable tool catalog while gating data calls on that user's OAuth
consent. The chart ships a Google Workspace MCP wrapper, an optional official
GitHub MCP backend, and per-user OAuth token storage in PostgreSQL. Every
workload is disabled by default and enabled explicitly.

The chart supports Kubernetes `1.32` and newer (`kubeVersion: >=1.32.0-0`).

## Install

The chart is published as an OCI artifact. Enabling `agentgateway` or any
authenticated wrapper requires at least one complete `hop1.issuers` entry, or
the install fails schema validation.

```bash
helm install mcp-gateway \
  oci://ghcr.io/apelogic-ai/charts/mcp-gateway \
  --version 0.5.3 \
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
    tag: "0.5.3"
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
    tag: "0.5.3"
  # Existing Secret supplying GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET,
  # GOOGLE_OAUTH_REDIRECT_URI, GOOGLE_TOKEN_ENCRYPTION_KEY, and TOKEN_STORE_DSN.
  secretRef:
    name: mcp-provider-runtime
```

Or override the same knobs inline:

```bash
helm install mcp-gateway oci://ghcr.io/apelogic-ai/charts/mcp-gateway \
  --version 0.5.3 \
  --set agentgateway.enabled=true \
  --set agentgateway.image.tag=0.5.3 \
  --set-string agentgateway.mcpAuthentication.resourceMetadata.resource=https://mcp.example.com/mcp \
  --set-json 'agentgateway.backends=[{"name":"google-workspace","enabled":true,"serviceName":"google-workspace","port":8080,"path":"/mcp"}]' \
  --set googleWorkspace.enabled=true \
  --set googleWorkspace.image.tag=0.5.3 \
  --set googleWorkspace.secretRef.name=mcp-provider-runtime \
  --set-json 'hop1.issuers=[{"name":"workforce","issuer":"https://identity.example.com","audiences":["https://mcp.example.com/mcp"],"jwksUrl":"https://identity.example.com/.well-known/jwks.json","allowedAlgorithms":["EdDSA"],"emailClaim":"email","subjectClaim":"sub"}]'
```

Runtime secrets are referenced as **existing** Kubernetes Secrets. Create them
from your own secret manager; the chart never generates credentials or embeds a
DSN, OAuth secret, or token encryption key in rendered manifests.
If one Secret also contains the broker's private `signing-jwks.json`, set
`secretRef.envKeys` on each wrapper to import only its runtime environment
keys. A non-empty allowlist replaces `envFrom` with individual Secret-key
references; an omitted or empty allowlist preserves the legacy whole-Secret
`envFrom` behavior and must not be used with a shared signing Secret. For
example, with an existing aggregate Secret named `mcp-runtime`:

```yaml
googleWorkspace:
  secretRef:
    name: mcp-runtime
    envKeys:
      - TOKEN_STORE_DSN
      - GOOGLE_OAUTH_CLIENT_ID
      - GOOGLE_OAUTH_CLIENT_SECRET
      - GOOGLE_OAUTH_REDIRECT_URI
      - GOOGLE_TOKEN_ENCRYPTION_KEY
  authorizationBroker:
    signingKeyring:
      secretKeyRef:
        name: mcp-runtime
        key: signing-jwks.json
```

The signing key is projected only as a file, never listed in `envKeys`. The
same allowlist option applies to `githubWrapper.secretRef` and
`dbMcp.secretRef`; list only the keys each workload needs.

Direct-client authorization is separately opt-in under
`googleWorkspace.authorizationBroker`. The typed values require a public HTTPS
issuer, exact MCP resource, Google callback, active public key ID, scopes, and
either constrained DCR or at least one static public client. The signing JWKS is
never a values or environment value: `signingKeyring.secretKeyRef` selects one
key from an existing Secret, and the chart projects it read-only at
`/var/run/secrets/mcp-gateway/broker/signing-jwks.json`. Broker mode also
requires AgentGateway, the Google backend, and either its public Ingress or the
opt-in broker-only Gateway API HTTPRoute. The chart creates a
provider-neutral DNS-label-bounded Service derived from
`<fullname>-authorization-broker` and selecting the existing Google wrapper
pods. Long fullnames are truncated with a stable identity hash so distinct
releases remain distinct. The chart routes the exact
metadata/authorize/token/register/JWKS/callback
paths to that Service, keeps the MCP resource behind AgentGateway, and adds the
broker issuer's RS256 profile to AgentGateway and every enabled first-party wrapper.
Internal JWKS retrieval uses the broker-role Service; public OAuth metadata continues
advertising the public HTTPS `jwks_uri`. The issuer, resource, callback, and public
host must describe one coherent HTTPS origin. See
`deploy/k8s/examples/values-oauth-broker.example.yaml` in the source repository.
Choose exactly one trusted ingress-source model. `ingressControllerPeer` must
contain non-empty Namespace and Pod label selectors for the actual in-cluster
data-plane proxy Pods, including Envoy Gateway when used. The Gateway object's
namespace alone does not identify those Pods. For an ALB/IP-target data plane, use non-empty
`ingressSourceCidrs` instead. The NetworkPolicy admits that exact source and
AgentGateway separately, without making the wrapper Service cluster-wide; a
missing, partial, or mixed source fails rendering. Do not use `0.0.0.0/0` in
place of the load balancer's actual source range.
Before installing a Gateway API overlay, inspect the proxy Pods and their
Namespace labels, for example with `kubectl get pods -A -o wide --show-labels`
and `kubectl get namespaces --show-labels`. Set `ingressControllerPeer` to
selectors matching those Pods and their Namespace, not the Gateway resource or
controller Deployment by assumption. If traffic arrives from external source
IPs instead, use the source CIDRs observed at the wrapper, not client CIDRs.
The chart cannot infer a dataplane identity from an HTTPRoute `parentRef`.

For an existing Gateway API `/mcp` HTTPRoute, set `agentgateway.ingress.enabled=false`
and `agentgateway.gatewayApi.brokerHttpRoute.enabled=true`, with one or more
`parentRefs` to the public HTTPS Gateway listener. The chart then creates only
an exact-path broker HTTPRoute on the issuer's host, pointing to the broker-role
Service; the environment retains ownership of `/mcp`, its protected-resource
metadata route, and provider-control routes. Do not add a broad `/oauth` prefix.
Ingress and broker HTTPRoute modes are mutually exclusive. The opt-in overlay
`deploy/k8s/examples/values-gateway-api-broker.example.yaml` demonstrates this
mode; replace its illustrative Gateway reference and data-plane selectors.
Verify the HTTPRoute's `Accepted` and `ResolvedRefs` conditions and public OAuth
discovery after reconciliation. The chart does not create the base `/mcp` route.

DCR remains disabled in the chart defaults: it exposes an unauthenticated client
registration endpoint and requires a deliberate policy and migration decision.
The Gateway API broker example explicitly enables constrained DCR.

The broker can be the only HOP-1 issuer for an external deployment: omit
`hop1.issuers` and the chart automatically trusts the broker issuer in Google,
GitHub, and AgentGateway. Optional internal workload issuers may coexist and remain
separate principals; explicitly configured profiles are preserved unchanged.
All configured issuers remain authentication providers, while the chart sets
`resourceMetadata.authorizationServers` to the public broker alone. Protected-resource
discovery therefore never exposes an internal issuer based on provider ordering.
Direct `https://accounts.google.com` HOP-1 trust
is incompatible with broker mode and is rejected.

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

## Private issuer trust and workload extensions

For a HOP-1 issuer whose HTTPS JWKS or introspection endpoint chains to a private
CA, reference one existing ConfigMap or Secret key containing a PEM bundle:

```yaml
trustBundle:
  enabled: true
  configMapKeyRef:
    name: platform-trust
    key: ca-bundle.pem
  secretKeyRef:
    name: ""
    key: ""
```

The chart mounts the bundle read-only in AgentGateway and both authenticated
wrappers. It sets `SSL_CERT_FILE` for AgentGateway and `NODE_EXTRA_CA_CERTS` for
the Bun wrappers. AgentGateway's `SSL_CERT_FILE` is its complete root set, so the
referenced PEM must contain every public and private root that AgentGateway must
trust; do not supply only a private delta when public issuers are also configured.
The chart stores no certificate content in values and accepts exactly one
complete ConfigMap or Secret reference.

Every workload also supports Kubernetes-native `extraEnv`, `extraVolumeMounts`,
and `extraVolumes` arrays. These are escape hatches for environment-specific
integrations rather than substitutes for typed chart contracts:

```yaml
googleWorkspace:
  extraEnv:
    - name: HTTPS_PROXY
      value: http://egress-proxy.platform.svc:8080
  extraVolumeMounts:
    - name: proxy-config
      mountPath: /etc/platform/proxy
      readOnly: true
  extraVolumes:
    - name: proxy-config
      configMap:
        name: proxy-config
```

The same extension fields are available on `agentgateway`, `githubWrapper`,
`dbMcp`, `githubMcp`, and `oauthMigrations`. Operators own the validity and
security of resources supplied through these generic fields.

## External governing platforms

An external platform can mint HOP-1 workload tokens, call the private provider
connection lifecycle, receive GitHub post-consent browser returns, and provide
one policy decision endpoint for both authenticated wrappers. Use
[`values-external-platform-issuer.example.yaml`](../examples/values-external-platform-issuer.example.yaml)
as the customer-neutral overlay starting point and see
[`docs/external-platform-issuer.md`](../../../docs/external-platform-issuer.md)
for the complete contract.

The issuer profile may use a fixed workload audience such as
`mcp-gateway-workload` rather than the public MCP URL. EdDSA is supported, and
an introspection credential is selected from an existing Secret through
`hop1.issuers[].introspection.credentialSecretKeyRef`. The same stable
`(issuer, subject)` must be presented to the lifecycle routes and later MCP
tool calls.

For GitHub consent, the issuer's resolved `emailClaim` must case-insensitively
match one of the user's verified GitHub email addresses. A mismatch consumes
the one-time OAuth state, revokes or queues cleanup of any issued credential,
does not activate a connection, and is reported as `identity_mismatch`. Align
the governing-platform login email with a verified GitHub email before
restarting consent.

Set `policy.opaUrl` for the shared OPA-compatible decision endpoint and
`githubWrapper.oauth.redirectAfterAllowedOrigins` for exact post-consent UI
origins. The chart rejects simultaneous typed and free-form versions of those
environment variables; legacy `env` configuration remains compatible while
the typed value is empty. Use `connectionLifecycle.allowedCallers` for private
ClusterIP reachability, and `trustBundle` when private HTTPS roots are needed.

## Private connection lifecycle access

An internal control plane can use the canonical authenticated
`/connections/{provider}/*` routes through each enabled wrapper's existing
ClusterIP Service. The chart does not publish those routes through its public
Ingress or HTTPRoute. Opt in by selecting the trusted caller Namespace and,
optionally, its Pods:

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

For a release named `mcp-gateway` in Namespace `mcp-gateway`, the internal base
URLs are `http://mcp-gateway-google-workspace.mcp-gateway.svc:8080` and
`http://mcp-gateway-github-wrapper.mcp-gateway.svc:8080`. Callers must still send
the user's valid HOP-1 bearer token; the NetworkPolicy allowlist does not bypass
authentication, principal binding, policy, or lifecycle generation guards. A
caller entry without `podSelector` admits all Pods in only the selected
Namespace. Provider callbacks remain separately routed return endpoints.

The rendered NetworkPolicies restrict reachability; they do not encrypt
in-cluster HTTP between AgentGateway and provider workloads. Use a service
mesh, sidecar, or equivalent platform control when transport confidentiality
inside the cluster is required. Egress remains deployment-owned because DNS,
PostgreSQL, identity, policy, and provider API destinations vary by cluster;
enforce it with the cluster's network policy or egress gateway once those
destinations are known.

## Minimal values

The smallest wrapper-only configuration is one `hop1.issuers` entry plus one
enabled wrapper workload. An AgentGateway deployment additionally requires a
non-empty `agentgateway.mcpAuthentication.resourceMetadata.resource` and at
least one enabled backend; an enabled in-chart backend also needs its matching
workload. The complete Google example under [Install](#install) is the smallest
public gateway configuration. Pin every image with `image.tag` or
`image.digest`; the defaults ship with an empty tag. Keep `scopesSupported`
aligned with the wrapper's identity scopes (`openid`, `email` by default).
Expose the endpoint by enabling `agentgateway.ingress` or fronting the
ClusterIP Service with your own gateway.

## Upgrade

```bash
helm upgrade mcp-gateway \
  oci://ghcr.io/apelogic-ai/charts/mcp-gateway \
  --version <new-version> \
  -f my-values.yaml
```

When upgrading to 0.5.3, change or remove an existing
`googleWorkspace.env.GWS_BINARY_PATH=/app/node_modules/.bin/gws` override. The image and chart now
default to `/usr/local/bin/gws`, and the wrapper refuses to start when an explicit path is not an
executable file. An existing `/usr/local/bin/gws` workaround may remain or be removed.

## Uninstall

```bash
helm uninstall mcp-gateway
```

Externally managed Secrets and the PostgreSQL data are not owned by the release
and are left in place.

## Key values

| Key                                                               | Default                                             | Description                                                                                                             |
| ----------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `hop1.issuers`                                                    | `[]`                                                | Optional direct HOP-1 issuer profiles. Required for enabled authenticated workloads unless the OAuth broker is enabled. |
| `policy.opaUrl`                                                   | `""`                                                | Shared OPA-compatible decision endpoint injected into both authenticated wrappers.                                      |
| `trustBundle.enabled`                                             | `false`                                             | Mount a complete private issuer CA bundle into AgentGateway and both authenticated wrappers.                            |
| `trustBundle.configMapKeyRef` / `secretKeyRef`                    | empty                                               | Exactly one existing PEM bundle reference when issuer trust is enabled.                                                 |
| `connectionLifecycle.enabled`                                     | `false`                                             | Admit selected private control-plane callers to wrapper Services; never creates a public route.                         |
| `connectionLifecycle.allowedCallers`                              | `[]`                                                | Namespace selectors and optional Pod selectors allowed by both wrapper NetworkPolicies.                                 |
| `agentgateway.enabled`                                            | `false`                                             | Deploy the `/mcp` front door.                                                                                           |
| `agentgateway.image.tag`                                          | `""`                                                | Agentgateway image tag (or set `image.digest`).                                                                         |
| `agentgateway.mcpAuthentication.resourceMetadata.resource`        | `""`                                                | Public MCP URL advertised in protected-resource metadata.                                                               |
| `agentgateway.backends`                                           | Google Workspace, db-mcp, github-mcp (all disabled) | Backend routing targets behind the shared endpoint.                                                                     |
| `agentgateway.ingress.enabled`                                    | `false`                                             | Expose `/mcp` and the protected-resource metadata path via Ingress.                                                     |
| `agentgateway.gatewayApi.brokerHttpRoute.enabled`                 | `false`                                             | Create only the broker's exact public HTTPRoute; requires an externally owned `/mcp` route and disables chart Ingress.  |
| `agentgateway.gatewayApi.brokerHttpRoute.parentRefs`              | `[]`                                                | Gateway listener references for the broker HTTPRoute when enabled.                                                      |
| `googleWorkspace.enabled`                                         | `false`                                             | Deploy the Google Workspace MCP wrapper.                                                                                |
| `googleWorkspace.secretRef.name`                                  | `""`                                                | Existing Secret with the wrapper's OAuth and token-store env.                                                           |
| `googleWorkspace.secretRef.envKeys`                               | `[]`                                                | Opt-in runtime-key allowlist; empty retains whole-Secret `envFrom`. Never include the signing key.                      |
| `googleWorkspace.authorizationBroker.enabled`                     | `false`                                             | Enable the public authorization broker and its typed fail-closed configuration.                                         |
| `googleWorkspace.authorizationBroker.signingKeyring.secretKeyRef` | empty                                               | Existing Secret name/key projected as the private signing keyring file.                                                 |
| `googleWorkspace.authorizationBroker.ingressControllerPeer`       | empty selectors                                     | Trusted in-cluster data-plane proxy Pods; choose this or `ingressSourceCidrs`, never both.                              |
| `googleWorkspace.authorizationBroker.ingressSourceCidrs`          | `[]`                                                | Trusted ALB/IP-target source CIDRs; choose this or `ingressControllerPeer`, never both.                                 |
| `googleWorkspace.authorizationBroker.dcr.enabled`                 | `false`                                             | Explicitly enable constrained dynamic client registration on the public broker route.                                   |
| `googleWorkspace.policy.enabled`                                  | `false`                                             | Enforce a YAML Google Workspace tool policy.                                                                            |
| `githubWrapper.oauth.redirectAfterAllowedOrigins`                 | `[]`                                                | Exact HTTPS (or explicit loopback HTTP) origins allowed after GitHub consent.                                           |
| `githubWrapper.enabled`                                           | `false`                                             | Deploy the GitHub MCP credential wrapper.                                                                               |
| `githubWrapper.secretRef.envKeys`                                 | `[]`                                                | Optional runtime-key allowlist for the GitHub wrapper Secret.                                                           |
| `githubMcp.enabled`                                               | `false`                                             | Deploy the bundled official GitHub MCP server backend.                                                                  |
| `dbMcp.enabled`                                                   | `false`                                             | Deploy the database MCP backend.                                                                                        |
| `dbMcp.secretRef.envKeys`                                         | `[]`                                                | Optional runtime-key allowlist for the database MCP Secret.                                                             |
| `<workload>.extraEnv` / `extraVolumeMounts` / `extraVolumes`      | `[]`                                                | Kubernetes-native extension points for environment-owned integrations.                                                  |
| `oauthMigrations.enabled`                                         | `false`                                             | Run OAuth token-store schema migrations as a Helm hook.                                                                 |
| `postgresql.caBundle.enabled`                                     | `false`                                             | Project a private CA bundle into wrappers and the migration job for TLS to PostgreSQL.                                  |
| `agentgateway.cors.allowOrigins`                                  | `["*"]`                                             | Browser origins allowed by AgentGateway CORS; replace the wildcard for browser-facing production deployments.           |
| `agentgateway.cors.allowHeaders`                                  | MCP protocol, content type, authorization           | Request headers allowed by AgentGateway CORS.                                                                           |
| `agentgateway.cors.exposeHeaders`                                 | `Mcp-Session-Id`                                    | Response headers exposed to browser clients.                                                                            |
| `agentgateway.backendFailureMode`                                 | `failOpen`                                          | AgentGateway backend failure behavior; set `failClosed` when partial backend availability must reject the request.      |
| `<workload>.resources`                                            | `{}`                                                | Per-workload resource requests and limits; copy and tune complete maps from the production examples.                    |
| `<workload>.securityContext.readOnlyRootFilesystem`               | `true` except `dbMcp`                               | Read-only container root filesystem; wrappers receive an ephemeral writable `/tmp`.                                     |
| `productionProfile.enabled`                                       | `false`                                             | Validate an explicit Google-only, GitHub-only, or combined provider production topology.                                |

See `docs/quickstart.md` in the source repository for the end-to-end install,
setup, and client-connection walkthrough.
