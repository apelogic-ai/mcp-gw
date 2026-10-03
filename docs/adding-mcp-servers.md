# Adding MCP Servers to MCP-GW

Status: public integration contract

This guide is for external developers and platform integrators who want to add
an MCP server behind MCP-GW's shared `/mcp` endpoint. It covers servers that
already speak MCP over HTTP, external container images, hosted MCP services,
CLI or stdio servers that need an HTTP wrapper, and integrations that need a
credential or policy wrapper.

MCP-GW is a federating gateway, not a universal process supervisor. The public
endpoint is owned by AgentGateway. Each configured backend must ultimately be
reachable as a Streamable HTTP MCP endpoint. A direct `agentgateway.backends`
target only routes to an existing HTTP endpoint. The optional `wrappers[]`
contract deploys MCP-GW's generic wrapper when an integration needs credential
replacement, a governed catalog, policy, audit, or an in-container stdio
adapter.

## Architecture and trust boundary

The normal direct path is:

```text
MCP client
  -- Authorization: Bearer <HOP-1 token> --> AgentGateway
  -- the same HOP-1 bearer token ----------> MCP backend
```

AgentGateway validates the caller token against `hop1.issuers`, then the
generated backend target uses `backendAuth.passthrough`. The original HOP-1
bearer token is therefore sent to every selected backend. A direct backend must
either validate and use that identity token or deliberately rely on
AgentGateway while remaining unreachable from untrusted networks.

An integration that needs a different downstream credential uses a wrapper:

```text
MCP client -- HOP-1 --> AgentGateway -- HOP-1 --> wrapper
wrapper -- HOP-2 provider token/API credential --> upstream MCP server or API
```

The wrapper validates HOP-1, resolves the stable principal, applies policy,
obtains the correct HOP-2 credential, and replaces—not forwards—the
`Authorization` header sent upstream. The bundled GitHub wrapper is the
reference HTTP-to-HTTP credential bridge; the Google Workspace wrapper is the
reference CLI-backed integration.

## Decision matrix

| Backend shape                                                                                                   | Recommended integration                                                                  | Why                                                                                                |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Existing in-cluster Streamable HTTP server that accepts the configured HOP-1 token                              | Add a direct `agentgateway.backends` target                                              | No protocol or credential translation is needed.                                                   |
| External container image with Streamable HTTP support                                                           | Deploy it with its own chart or manifests, then add its Service URL as a backend         | `agentgateway.backends` configures routing only; it does not create arbitrary workloads.           |
| Externally hosted MCP server that is trusted to receive and validate HOP-1                                      | Add its HTTPS URL as a backend                                                           | AgentGateway can connect directly when the identity and trust contracts already match.             |
| Externally hosted server that expects an API key, provider OAuth token, or its own bearer                       | Configure a generic wrapper                                                              | Direct targets cannot inject per-backend secrets or exchange the caller token.                     |
| CLI or stdio server                                                                                             | Put the CLI and generic wrapper in one pinned image                                      | AgentGateway cannot launch or speak stdio to a backend; the wrapper owns that process boundary.    |
| Server whose tools need per-user provider OAuth, operation policy, audit, aliases, or a stable governed catalog | Configure a generic wrapper; write code only for provider-specific semantics             | The descriptor covers standard credential modes while the catalog fixes the governed tool surface. |
| New first-party integration maintained and released by MCP-GW                                                   | Add the wrapper/server, descriptor, deployment contract, tests, docs, and release inputs | A repository integration has compatibility and supply-chain obligations beyond a private overlay.  |

## Baseline backend contract

Before adding any routing configuration, verify the backend contract directly.

### Transport and protocol

The backend must:

- expose an HTTP or HTTPS URL ending in the MCP resource path, normally
  `/mcp`;
- support Streamable HTTP and JSON-RPC request IDs;
- complete `initialize`, accept `notifications/initialized`, and implement the
  capabilities it advertises;
- support `tools/list` and `tools/call` when it advertises tools;
- return protocol-valid responses for any advertised resources, prompts, or
  subscriptions;
- preserve `Mcp-Session-Id` semantics if it is stateful; and
- work with the repository's tested MCP protocol baseline, `2025-06-18`.

A stdio-only server is not a backend target until an HTTP wrapper exposes this
contract. If a backend uses streaming responses or maintains in-memory
sessions, test it through AgentGateway and across backend replicas; a
Kubernetes Service may send successive requests to different Pods.

### Tool namespace and catalog stability

MCP-GW configures `prefixMode: never`. AgentGateway forwards the exact tool
name advertised by a backend and does not add or remove a prefix. Consequently:

- every tool name must be globally unique across all enabled backends;
- use a stable provider or product prefix such as `search_`, `crm_`, or
  `github_`;
- do not depend on the backend target `name` or registry `toolPrefix` to rename
  tools—they identify targets and catch descriptor collisions only;
- keep tool names, input schemas, output shapes, and action semantics stable
  across patch releases; and
- keep `tools/list` stable across a user's connected/disconnected state when
  clients may cache catalogs. Advertise connection helpers and data tools
  consistently, then fail an unauthorized data call with a structured error.

Run a merged-catalog test before enabling a second backend. Duplicate tool
names, unstable schemas, or user-dependent catalogs can produce ambiguous
routing and stale client approvals even when each backend works alone.

### Authentication and authorization

Adding a target does not add provider OAuth or tool policy. Choose one explicit
model:

1. **Direct HOP-1 validation.** The backend verifies the forwarded bearer token
   using the same issuer, audience, algorithm allowlist, and stable subject
   contract as AgentGateway.
2. **Gateway-only authentication.** The backend trusts AgentGateway's decision,
   ignores the forwarded bearer, is exposed only on a private network, and
   allows ingress only from AgentGateway. This is simpler but makes network
   isolation part of the security boundary.
3. **Credential or policy wrapper.** The wrapper validates HOP-1, keys user
   state by stable `issuer + subject`, applies local or external policy, obtains
   HOP-2, and sends only HOP-2 upstream.

Use a wrapper when the backend expects any credential other than the HOP-1
token. A direct `agentgateway.backends` target has no supported field for a
static `Authorization` header, API key, client secret, or per-user token
exchange; use `wrappers[]` for those cases.
Do not put credentials in the backend URL. Do not send customer HOP-1 tokens to
a third-party hosted service unless that service is explicitly trusted to
receive and validate them.

MCP-GW's Google and GitHub OAuth lifecycle is not automatically inherited by a
new backend. A provider-aware integration must define its own consent scopes,
credential validation, renewal, revocation, encrypted persistence, callback
route, migrations, status/error contract, cleanup worker, and disconnect
semantics—or delegate them to a trusted external control plane.

Likewise, the shared YAML/OPA tool-policy implementation is called by the
bundled wrappers. A direct generic target is authenticated at the gateway but
does not automatically receive per-tool or argument-aware policy decisions.
Use a wrapper if rules such as “deny this operation” or “inspect recipient
arguments” must be enforced centrally.

## Configuration patterns

The following complete skeleton shows the shared values every custom backend
deployment starts from. Replace the identity coordinates, public resource URL,
and backend URL; expose the AgentGateway Service through your environment's
Ingress, Gateway API route, or load balancer.

```yaml
hop1:
  issuers:
    - name: workforce
      issuer: https://identity.example.com
      audiences:
        - https://mcp.example.com/mcp
      jwksUrl: https://identity.example.com/.well-known/jwks.json
      allowedAlgorithms:
        - RS256
      emailClaim: email
      subjectClaim: sub

agentgateway:
  enabled: true
  image:
    repository: ghcr.io/apelogic-ai/mcp-gw-agentgateway
    digest: sha256:<release-digest>
  mcpAuthentication:
    resourceMetadata:
      resource: https://mcp.example.com/mcp
      scopesSupported:
        - openid
        - email
  backends:
    - name: enterprise-search
      enabled: true
      host: http://enterprise-search.search.svc.cluster.local:8080/mcp
```

The issuer `audiences` must describe the tokens clients actually send. The
protected-resource `resource` is the public MCP URL clients discover; it does
not have to equal the token audience unless the issuer uses that URL as its
audience. Pin the AgentGateway digest from the selected MCP-GW release handoff.

### Existing in-cluster server

For a workload installed by another chart or by separate manifests, use its
fully qualified Service URL in a private values overlay:

```yaml
agentgateway:
  enabled: true
  backends:
    - name: enterprise-search
      enabled: true
      host: http://enterprise-search.search.svc.cluster.local:8080/mcp
```

Use `host` for externally managed Services. The `serviceName`, `port`, and
`path` shorthand is for components rendered by this chart because the helper
derives a release-scoped Service name.

The backend Deployment is independently owned. At minimum, pin an immutable
image digest, run as a non-root user, drop Linux capabilities, configure
readiness/liveness probes and resources, and restrict ingress to the
AgentGateway workload. Do not expose the backend Service publicly.

### External container image

The chart does not have a generic `image` field under
`agentgateway.backends`. Deploy the image separately, make it listen on an
internal Streamable HTTP endpoint, and then point MCP-GW at that Service:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: enterprise-search
  namespace: search
spec:
  selector:
    matchLabels:
      app: enterprise-search
  template:
    metadata:
      labels:
        app: enterprise-search
    spec:
      containers:
        - name: mcp
          image: registry.example.com/mcp/enterprise-search@sha256:<digest>
          args: ["--transport", "streamable-http", "--host", "0.0.0.0", "--port", "8080"]
          ports:
            - name: http
              containerPort: 8080
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
---
apiVersion: v1
kind: Service
metadata:
  name: enterprise-search
  namespace: search
spec:
  selector:
    app: enterprise-search
  ports:
    - name: http
      port: 8080
      targetPort: http
```

This is illustrative, not a complete production manifest. Add Pod security,
NetworkPolicy, probes, resource requests/limits, scheduling, secret references,
and disruption controls appropriate to the server.

Do not repurpose `googleWorkspace`, `githubMcp`, `githubWrapper`, or `dbMcp`
values for an unrelated image. Those are typed workloads with provider-specific
commands, environment, validation, Services, and security assumptions.

### Externally hosted MCP server

An HTTPS backend can be routed directly:

```yaml
agentgateway:
  enabled: true
  backends:
    - name: hosted-search
      enabled: true
      host: https://mcp.search-provider.example/mcp
```

This is appropriate only when the hosted service is trusted to receive the
caller's HOP-1 token and understands that token's issuer/audience contract. If
it expects its own OAuth token or API key, deploy a wrapper in your environment
and route MCP-GW to the wrapper instead.

For a private CA, configure `trustBundle` with one existing ConfigMap or Secret
key. AgentGateway uses the selected file as its complete CA set, so include all
public and private roots it needs:

```yaml
trustBundle:
  enabled: true
  configMapKeyRef:
    name: enterprise-ca-bundle
    key: ca-bundle.pem
```

Confirm DNS, TLS server-name validation, egress policy, proxy behavior,
timeouts, and regional latency from the AgentGateway Pod—not only from a
developer laptop.

### CLI or stdio server

A CLI or stdio server needs a local HTTP adapter. The wrapper should own the
process boundary and expose `/mcp` on a fixed port. The Google Workspace wrapper
is the in-repository example.

For each tool call, the wrapper should:

1. authenticate HOP-1 and authorize the resolved tool and arguments;
2. obtain any scoped HOP-2 credential without accepting it from tool arguments;
3. construct an argument vector without a shell;
4. pass secrets through the child environment or a protected file, never the
   command line or logs;
5. apply a deadline and output-size limit;
6. terminate the child on cancellation or timeout;
7. parse and sanitize stdout/stderr into a stable MCP result; and
8. avoid shared mutable process environment so concurrent users cannot exchange
   credentials.

Package the wrapper and pinned CLI together when possible. Fail startup if the
binary is missing or incompatible, and add a real container smoke test so the
published image—not only mocked process execution—is exercised.

### Credential or policy wrapper

Use this pattern when a backend is already Streamable HTTP but cannot consume
HOP-1 directly. The wrapper is an MCP-aware reverse proxy. It should:

- validate the HOP-1 bearer again when the wrapper Service is independently
  reachable;
- resolve a stable principal from immutable claims, normally `(iss, sub)`;
- advertise a deterministic tool catalog without contacting the upstream for
  every user;
- classify and authorize the resolved operation before obtaining credentials;
- resolve or renew HOP-2 under that principal;
- remove HOP-1 and inject HOP-2 only on the upstream request;
- forward MCP protocol and session headers deliberately, not all inbound
  headers;
- sanitize provider errors and never log tokens or response bodies containing
  secrets; and
- emit bounded audit/diagnostic fields that identify the operation and policy
  rule without personal data.

If the wrapper owns provider OAuth, expose exact callback and lifecycle routes
and route only those required public callback paths. Do not expose a broad
`/oauth` or `/connections` prefix. The current built-in authorization broker is
configured under `googleWorkspace.authorizationBroker`; enabling it does not
automatically add direct-client OAuth for a custom backend.

### Generic wrapper

`wrappers[]` is the recommended chart path for an existing MCP server that
needs a credential bridge, a stable prefixed catalog, YAML/OPA policy, audit,
or stdio adaptation. It is additive and empty by default. Each enabled entry
creates a Deployment, ClusterIP Service, ServiceAccount (unless an existing
one is selected), ingress-only NetworkPolicy, descriptor ConfigMap, and
AgentGateway target.

The wrapper always validates HOP-1 and never forwards its bearer upstream. Its
catalog is authoritative: only listed tools are advertised, each upstream tool
is exposed as `<toolPrefix>_<name>`, and each call is classified before a
credential is resolved. Pin the generic-wrapper image digest from the matching
MCP-GW release handoff. A configured sidecar image must also be digest-pinned.
The wrapper issues opaque MCP session IDs, binds them to the immutable HOP-1
principal, rejects caller-invented session IDs, and reaps idle sessions on a
timer. Optional per-wrapper limits are explicit:

```yaml
sessions:
  maxTotal: 64
  maxPerPrincipal: 4
  idleTtlMs: 1800000
```

These are the defaults. Keep the per-principal limit below the total so one
caller cannot exhaust capacity for every other caller.

The examples below assume the `hop1.issuers` and
`agentgateway.mcpAuthentication.resourceMetadata` settings shown in the
[complete skeleton](#configuration-patterns). `agentgateway.backends` may be
empty because each enabled wrapper creates its own target.

#### Streamable HTTP with no upstream credential

```yaml
agentgateway:
  enabled: true
  backends: []

wrappers:
  - name: public-reference
    enabled: true
    image:
      repository: ghcr.io/apelogic-ai/mcp-gw-generic-wrapper
      digest: sha256:<generic-wrapper-release-digest>
    toolPrefix: reference
    lifecycleRoutes: false
    upstream:
      transport: http
      url: https://mcp.example.com/mcp
    credential:
      mode: none
    serverInfo:
      name: public-reference-wrapper
      version: "1.0.0"
    catalog:
      catalogId: public-reference@1
      tools:
        - name: echo
          description: Echo a message through the reference server.
          inputSchema:
            type: object
            properties:
              message:
                type: string
            required: [message]
            additionalProperties: false
          annotations:
            readOnlyHint: true
          grants:
            actionClass: read
            operation: reference.echo
            scopes: []
```

This mode means “authenticate at the wrapper, send no credential upstream.” It
does not mean anonymous access to MCP-GW; `/mcp` still requires HOP-1.

#### Streamable HTTP with an API-key Secret

Create the Secret through the deployment's secret manager. For a one-off
development namespace, the equivalent command is:

```bash
kubectl create secret generic hosted-search-credentials \
  --namespace mcp-gateway \
  --from-literal=HOSTED_SEARCH_API_KEY='<provider-api-key>'
```

Reference only the key name in values:

```yaml
wrappers:
  - name: hosted-search
    enabled: true
    image:
      repository: ghcr.io/apelogic-ai/mcp-gw-generic-wrapper
      digest: sha256:<generic-wrapper-release-digest>
    toolPrefix: hosted_search
    lifecycleRoutes: false
    upstream:
      transport: http
      url: https://search-api.example.com/mcp
    credential:
      mode: static_secret
      env: HOSTED_SEARCH_API_KEY
      header: x-api-key
    secretRef:
      name: hosted-search-credentials
      envKeys: [HOSTED_SEARCH_API_KEY]
    serverInfo:
      name: hosted-search-wrapper
      version: "1.0.0"
    catalog:
      catalogId: hosted-search@1
      tools:
        - name: query
          description: Search indexed documents.
          inputSchema:
            type: object
            properties:
              query:
                type: string
            required: [query]
            additionalProperties: false
          annotations:
            readOnlyHint: true
          grants:
            actionClass: read
            operation: search.query
            scopes: []
```

Set `credential.scheme` when the provider expects a value such as
`Authorization: Bearer <secret>`; omit it for a raw API-key header. The chart
rejects a credential environment name that is not explicitly imported from
`secretRef.envKeys` and rejects Secret/`extraEnv` collisions with wrapper-owned
variables.

#### Per-user OAuth provider

Standard authorization-code providers can use `per_user_oauth`. MCP-GW binds
state and encrypted credentials to the immutable HOP-1 `(issuer, subject)`,
validates the provider user-info email against the HOP-1 email, renews tokens,
and revokes them when a revocation endpoint is configured.

```yaml
connectionLifecycle:
  enabled: true
  allowedCallers:
    # Select the actual ingress data-plane Pods delivering the callback.
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: gateway-system
      podSelector:
        matchLabels:
          app.kubernetes.io/name: public-gateway

oauthMigrations:
  enabled: true
  image:
    repository: ghcr.io/apelogic-ai/mcp-gw-generic-wrapper
    digest: sha256:<generic-wrapper-release-digest>
  secretKeyRef:
    name: search-oauth-runtime
    key: TOKEN_STORE_DSN

wrappers:
  - name: user-search
    enabled: true
    image:
      repository: ghcr.io/apelogic-ai/mcp-gw-generic-wrapper
      digest: sha256:<generic-wrapper-release-digest>
    toolPrefix: user_search
    lifecycleRoutes: true
    upstream:
      transport: http
      url: https://search-api.example.com/mcp
    credential:
      mode: per_user_oauth
      providerId: search-provider
      authorizationUrl: https://accounts.example.com/oauth/authorize
      tokenUrl: https://accounts.example.com/oauth/token
      userInfoUrl: https://accounts.example.com/oauth/userinfo
      revocationUrl: https://accounts.example.com/oauth/revoke
      redirectUri: https://mcp.example.com/oauth/search-provider/callback
      scopes: [search.read]
      clientIdEnv: SEARCH_OAUTH_CLIENT_ID
      clientSecretEnv: SEARCH_OAUTH_CLIENT_SECRET
      encryptionKeyEnv: SEARCH_TOKEN_ENCRYPTION_KEY
      tokenStoreDsnEnv: TOKEN_STORE_DSN
      identity:
        idField: sub
        emailField: email
        emailVerifiedField: email_verified
    secretRef:
      name: search-oauth-runtime
      envKeys:
        - SEARCH_OAUTH_CLIENT_ID
        - SEARCH_OAUTH_CLIENT_SECRET
        - SEARCH_TOKEN_ENCRYPTION_KEY
        - TOKEN_STORE_DSN
    serverInfo:
      name: user-search-wrapper
      version: "1.0.0"
    catalog:
      catalogId: user-search@1
      tools:
        - name: query
          description: Search documents available to the connected user.
          inputSchema:
            type: object
            properties:
              query:
                type: string
            required: [query]
            additionalProperties: false
          annotations:
            readOnlyHint: true
          grants:
            actionClass: read
            operation: search.query
            scopes: [search.read]
```

The Secret contains the four named keys. The encryption key is a base64-encoded
32-byte key, and `TOKEN_STORE_DSN` points to the PostgreSQL database migrated by
the hook. Provider IDs must be unique and cannot reuse the built-in `google` or
`github` storage namespaces. The redirect URI must use the exact
`/oauth/<providerId>/callback` path and must be registered with the provider.

The chart deliberately does not publish generic provider routes. Route only
the exact callback to the generated wrapper Service; keep authenticated
`/connections/<providerId>/*` routes private. For a release named
`mcp-gateway`, a Gateway API route has this shape:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: search-provider-callback
  namespace: mcp-gateway
spec:
  parentRefs:
    - name: public
      namespace: gateway-system
      sectionName: https
  hostnames: [mcp.example.com]
  rules:
    - matches:
        - path:
            type: Exact
            value: /oauth/search-provider/callback
      backendRefs:
        - name: mcp-gateway-generic-wrapper-user-search
          port: 8080
```

The wrapper publishes stable `user_search_oauth_status` and
`user_search_oauth_start` helper tools. An internal control plane may instead
use the authenticated routes described under
[Private connection lifecycle access](#private-connection-lifecycle-access).

#### Stdio server in the wrapper container

Kubernetes containers cannot share stdin/stdout with a sidecar. Package a
trusted stdio server in the same image as the generic wrapper, or run it as an
HTTP sidecar and select `transport: http`. A stdio child executes inside the
wrapper's security boundary and can observe any credential deliberately
injected into it, so do not package unreviewed commands. This Dockerfile shape
vendors the public MCP Everything reference server without changing MCP-GW
source:

```dockerfile
FROM oven/bun:1.2.21@sha256:5a2011bf09364b9af658ac1e66f60d08092f4291aeefbff448d58b027734fdd0 AS reference
WORKDIR /reference
RUN bun add @modelcontextprotocol/server-everything@2026.8.31

FROM ghcr.io/apelogic-ai/mcp-gw-generic-wrapper@sha256:<generic-wrapper-release-digest>
COPY --from=reference /reference /opt/reference
```

Push the derived image and pin its digest:

```yaml
wrappers:
  - name: everything-stdio
    enabled: true
    image:
      repository: registry.example.com/mcp/everything-wrapper
      digest: sha256:<derived-image-digest>
    replicas: 1
    toolPrefix: reference
    lifecycleRoutes: false
    upstream:
      transport: stdio
      command: /usr/local/bin/bun
      args:
        - /opt/reference/node_modules/@modelcontextprotocol/server-everything/dist/index.js
        - stdio
    credential:
      mode: none
    serverInfo:
      name: everything-wrapper
      version: "1.0.0"
    catalog:
      catalogId: modelcontextprotocol-everything@2026.8.31
      tools:
        - name: echo
          description: Echo a message through the public reference server.
          inputSchema:
            type: object
            properties:
              message:
                type: string
            required: [message]
            additionalProperties: false
          annotations:
            readOnlyHint: true
          grants:
            actionClass: read
            operation: reference.echo
            scopes: []
```

Stdio sessions are process-local, so the chart enforces one wrapper replica.
The wrapper starts one child per authenticated MCP session, binds it to the
HOP-1 principal, injects only explicitly allowlisted environment variables and
the resolved provider credential, serializes calls within the session, and
terminates the child on session deletion, timeout, protocol mismatch, or idle
expiry. Runtime bounds protect both transport types: by default each wrapper
keeps at most 64 sessions globally and 4 per HOP-1 principal, and a timer reaps
idle entries after 30 minutes. Override `sessions` only after sizing the
wrapper's memory, file-descriptor, and child-process budgets.

## Wrapper SDK status

MCP-GW does not currently publish a supported wrapper SDK, npm package, or
code-generator. The repository contains a private, structured TypeScript
package at [`packages/wrapper-kit`](../packages/wrapper-kit) for the bundled
wrappers. It defines internal interfaces for HOP-1 authentication, credential
bridges, policy and audit assembly, HTTP proxying, server-side tool registries,
lifecycle routes, and sanitized errors. They are internal source modules rather than stable external APIs.
Their import paths and interfaces may change with MCP-GW itself.

The released generic-wrapper image is the supported configuration surface for
integrations covered by `wrappers[]`; using it does not require importing the
internal TypeScript package. Custom code is still responsible for semantics
that the descriptor cannot express.

The closest reference implementations are:

- [`servers/generic-wrapper`](../servers/generic-wrapper), the descriptor-driven
  HTTP/stdio bridge shipped as the generic-wrapper image;
- [`servers/github-mcp/wrapper/src/proxy.ts`](../servers/github-mcp/wrapper/src/proxy.ts),
  an HTTP-to-HTTP MCP credential bridge; and
- [`servers/google-workspace/wrapper/src/runtime.ts`](../servers/google-workspace/wrapper/src/runtime.ts),
  together with its MCP HTTP handler and executor, for an authenticated
  CLI-backed wrapper.

The bundled wrappers consume the kit while provider-specific adapters retain
their catalogs, grants, OAuth exchanges, and execution behavior. Supporting
internal modules include HOP-1 identity handling under
[`shared/identity`](../shared/identity), tool policy under
[`shared/policy`](../shared/policy), audit support under
[`shared/audit`](../shared/audit), and provider credential lifecycle under
[`shared/oauth`](../shared/oauth). External integrations may study or vendor
these patterns, but should pin the copied code to a reviewed MCP-GW release and
own its compatibility rather than importing repository-relative modules as an
SDK.

Until a supported SDK exists, a wrapper implementation must explicitly provide:

1. HOP-1 validation and stable principal resolution;
2. upstream credential resolution or exchange;
3. tool classification, policy, and audit where required;
4. replacement of HOP-1 with HOP-2 on upstream requests;
5. deliberate MCP protocol/session header forwarding;
6. sanitized errors and secret-safe logging; and
7. protocol, authentication, policy, concurrency, and failure tests.

A future supported SDK would version and publish these interfaces and add stable
configuration parsing and provider extension points. The repository now ships
a standalone URL-driven conformance runner, described below; a future SDK would
package its programmatic conformance test kit and fixture controls as a stable
API. Unless that supported package is named in MCP-GW release notes,
integrators should treat both `packages/wrapper-kit` and the in-process test
harness as implementation details rather than SDK dependencies.

## Helm behavior and limitations

Every enabled deployment still needs the normal public MCP contract:

- at least one complete `hop1.issuers` entry unless the built-in broker is the
  sole issuer;
- a non-empty
  `agentgateway.mcpAuthentication.resourceMetadata.resource` matching the
  public MCP URL;
- at least one enabled backend; and
- a public route to `/mcp` and
  `/.well-known/oauth-protected-resource/mcp` when discovery is required.

Backend entries use one of these forms:

```yaml
# Chart-owned component
- name: google-workspace
  enabled: true
  serviceName: google-workspace
  port: 8080
  path: /mcp

# Separately deployed or remote component
- name: enterprise-search
  enabled: true
  host: http://enterprise-search.search.svc.cluster.local:8080/mcp
```

`agentgateway.backendFailureMode` defaults to `failOpen`. During discovery, one
unavailable optional target can be skipped when another is healthy. Use
`failClosed` if a partial catalog or partial enforcement boundary is less safe
than rejecting the request. Test the chosen behavior by deliberately stopping
each backend.

Changing backend values changes the generated ConfigMap checksum and rolls the
AgentGateway Deployment on Helm upgrade. It is not a live, no-restart plugin
operation.

`productionProfile.enabled` currently validates only the chart's supported
Google Workspace and GitHub production topologies. Leave it `false` for a
custom-only backend deployment and enforce equivalent production controls in
your own overlay. Do not disable validation by supplying a fake built-in
backend. A proposal to make custom production profiles first-class should add
typed schema and tests rather than weakening the existing checks.

### Opt-in governed db-mcp mode

`dbMcp.enabled=true` keeps its historical direct topology unless
`dbMcp.wrapper.enabled=true` is also set. The opt-in mode adds the released
generic-wrapper image as a sidecar, keeps the Service address and AgentGateway
target unchanged, and redirects the Service to the sidecar. The sidecar
validates HOP-1, owns MCP sessions, exposes only the configured catalog, applies
optional policy/audit, and calls db-mcp over Pod loopback without forwarding
the HOP-1 bearer.

Start from
[`values-db-mcp-wrapped.example.yaml`](../deploy/k8s/examples/values-db-mcp-wrapped.example.yaml).
Pin both images by digest and replace the example catalog with the exact tools
and schemas exposed by the selected db-mcp version. MCP-GW does not publish or
pin the external db-mcp image, so catalog/version drift remains the operator's
responsibility. Disabling `dbMcp.wrapper` restores the original Deployment,
Service target, NetworkPolicy port, and direct request path.

The conformance review records these direct-mode gaps rather than hiding them:

- AgentGateway passes the HOP-1 bearer to db-mcp instead of terminating it at a
  credential boundary;
- MCP-GW cannot apply a pinned grant catalog, per-tool policy, or its audit
  contract before a direct call reaches db-mcp;
- session behavior and secret-safe error/log handling belong entirely to the
  externally supplied db-mcp build; and
- because MCP-GW does not publish that image, this repository cannot reproduce
  the direct runtime in CI from its own immutable release inputs.

The wrapped mode closes the first three gaps at the MCP-GW boundary and passes
the shared in-repository conformance suite using the chart-rendered descriptor
and catalog. Operators must still run the URL profile against their chosen
digest because its upstream implementation remains external.

### Built-in GitHub upstream topology

The built-in GitHub integration can optionally run its official upstream in
the GitHub wrapper Pod by setting `githubMcp.topology: sidecar`. This is a
deployment optimization for that governed integration, not a generic way to
attach arbitrary containers. The upstream binds to loopback, the standalone
GitHub MCP workload and Service are omitted, and the wrapper continues to own
HOP-1 authentication, per-user GitHub credential replacement, policy, audit,
the stable catalog, and MCP sessions. The default remains `separate` for full
backward compatibility. See the chart README for switching, rollback, and
which Pod-level controls move to `githubWrapper`.

## Docker Compose and source-tree registration

The repository's Compose setup mounts a generated AgentGateway config. A
first-class source contribution adds `servers/<backend>/backend.yaml`:

```yaml
name: enterprise-search
host: http://enterprise-search:8080/mcp
toolPrefix: search
enabledByDefault: false
```

Then regenerate and validate:

```bash
bun scripts/generate-agentgateway-config.ts
bun run backends:check
```

The reusable `servers/generic-wrapper` runtime is intentionally not a concrete
source-tree backend: it has no fixed host or tool prefix until an operator
creates a `wrappers[]` instance. Do not add a placeholder backend descriptor
for the runtime itself.

Add a Compose overlay that starts the backend, but remember that a service
overlay alone does not mutate the mounted gateway config. Use the generated
federated config only when every included target is deployed, or maintain a
private AgentGateway config containing exactly the targets for that
environment. Restart AgentGateway after changing the mounted config.

The descriptor contract is intentionally small:

- `name`: stable backend descriptor name;
- `host`: HTTP MCP endpoint used by generated Compose configs;
- `toolPrefix`: unique registry/target identifier, not a tool-name rewrite; and
- `enabledByDefault`: whether the target belongs in the base config.

External Helm users do not need to fork MCP-GW or add a descriptor. A private
`agentgateway.backends` overlay is enough when the backend already satisfies
the transport, identity, policy, and catalog contracts.

## Backend conformance kit

The repository includes a URL-driven conformance runner for direct wrapper
endpoints and AgentGateway endpoints:

```bash
bun run conformance:backend --config ./backend-conformance.yaml
```

The configuration contains environment-variable **names**, never bearer values:

```yaml
schemaVersion: mcp-gateway.backend-conformance/v1
name: hosted-search
url: https://mcp.example.com/mcp
sessionMode: required
policyDenial: mcp_tool_error
tokens:
  validEnv: MCP_CONFORMANCE_VALID_TOKEN
  expiredEnv: MCP_CONFORMANCE_EXPIRED_TOKEN
  wrongAudienceEnv: MCP_CONFORMANCE_WRONG_AUDIENCE_TOKEN
  otherPrincipalEnv: MCP_CONFORMANCE_OTHER_PRINCIPAL_TOKEN
toolCall:
  name: search_query
  arguments:
    query: conformance marker
concurrency: 4
requestTimeoutMs: 10000
```

Supply short-lived test tokens from a secret manager, then run the command in a
test environment. The baseline profile checks missing, expired, and
wrong-audience authentication; initialize and initialized notification;
tools/list and one read-only tools/call; session issuance and principal binding
when required; and concurrent catalog reads. The JSON report contains only
check names and sanitized failure descriptions. Each request is bounded by
`requestTimeoutMs` (10 seconds by default), so a stalled fixture fails instead
of hanging the runner.

Controlled deployments can add scenario endpoints to test policy and failure
behavior. Each endpoint must expose the same MCP contract while its fixture is
configured for the named condition:

```yaml
scenarios:
  policyDenied:
    url: https://deny.mcp.example.com/mcp
  upstream5xx:
    url: https://provider-5xx.mcp.example.com/mcp
  upstreamTimeout:
    url: https://provider-timeout.mcp.example.com/mcp
  gatewayFailOpen:
    url: https://fail-open.mcp.example.com/mcp
  gatewayFailClosed:
    url: https://fail-closed.mcp.example.com/mcp
```

The two gateway scenarios use deployments with the corresponding
`agentgateway.backendFailureMode`. The fail-open target must still complete the
configured healthy read when another backend is unavailable; the fail-closed
target must reject that partial result.

For secret-custody checks, capture sanitized upstream request metadata and
wrapper logs to local files, then name both the files and secret-bearing
environment variables under `evidence`. The runner checks that HOP-1 never
appears upstream, the expected HOP-2 value does, and neither credential appears
in responses or logs. Never point evidence collection at production logs or
put literal credentials in the YAML.

The in-repository suite binds this same runner to the generic, GitHub, and
Google Workspace handlers with deterministic policy, 5xx, timeout, concurrency,
credential-isolation, and log-capture fixtures. The portable URL profile is the
supported starting point for an external integration; repository-relative
test harness APIs remain internal until a versioned conformance package is
published.

## Compatibility acceptance checklist

Test the exact deployed topology, not only the backend in isolation. Run the
[backend conformance kit](#backend-conformance-kit) for the direct wrapper and
again through AgentGateway; retain its JSON report with the deployment review.

### Protocol

- `initialize` succeeds through the public gateway with protocol `2025-06-18`.
- `notifications/initialized` is accepted without an invalid JSON-RPC response.
- `tools/list` contains the expected stable, globally unique names and schemas.
- One read-only `tools/call` reaches the intended backend and preserves its
  request ID and result.
- Invalid methods and invalid tool arguments return protocol-valid errors.
- `Mcp-Session-Id`, streaming, cancellation, and reconnect behavior work when
  the backend advertises them.

### Authentication and policy

- Missing, malformed, wrong-audience, expired, and disallowed-algorithm HOP-1
  tokens fail closed.
- A valid token reaches only the intended backend.
- Direct backends validate HOP-1, or network policy proves only AgentGateway can
  reach a gateway-trusting backend.
- Wrappers never forward HOP-1 upstream and never expose HOP-2 to clients,
  arguments, errors, audit logs, or metrics.
- Per-tool and argument-aware denials run before the upstream side effect.
- Two distinct `(iss, sub)` principals cannot read or use each other's stored
  credentials.

### Federation and failure

- Tool names do not collide with every other enabled backend.
- The catalog remains stable before and after provider connection.
- Stopping the new backend produces the intended `failOpen` or `failClosed`
  behavior without corrupting other sessions.
- Multiple backend replicas either share session state or route sessions
  safely.
- A backend timeout, 429, 5xx, malformed response, and oversized response are
  bounded and classified without leaking upstream content.

### Operations

- Images and charts are pinned by digest and their provenance is verified.
- Readiness prevents traffic before the endpoint can initialize.
- Logs contain operation/diagnostic identifiers but no bearer tokens, OAuth
  codes, refresh tokens, API keys, personal data, or full provider bodies.
- Resource limits, disruption behavior, egress, DNS, TLS trust, and secret
  rotation have been exercised.
- Only AgentGateway is public; custom callback routes are exact and separately
  reviewed.

For a source contribution, run the repository gates:

```bash
bun install
bun run ci
bun run deploy:check
```

Add focused unit tests, a direct backend contract test, and an end-to-end smoke
through AgentGateway. If MCP-GW publishes the new image, also update the release
workflow, release handoff, build-from-source instructions, SBOM/vulnerability
evidence, and immutable-digest verification.

## First-class contribution checklist

A new maintained backend normally includes:

1. `servers/<backend>/backend.yaml` and regenerated gateway configs;
2. wrapper/server source plus a pinned, hardened Dockerfile;
3. a Compose overlay when local evaluation is supported;
4. typed Helm values, schema, templates, validation, NetworkPolicy, Service,
   probes, scheduling, Secret references, and an example when the chart owns the
   workload;
5. stable prefixed tools and a documented catalog/versioning policy;
6. explicit HOP-1/HOP-2 and policy boundaries;
7. provider lifecycle routes, persistence, migrations, and exact callback
   routing when OAuth is owned by MCP-GW;
8. unit, protocol, authentication, federation, failure, container, and
   Kubernetes smoke tests; and
9. release/build/provenance documentation when an artifact becomes part of the
   MCP-GW release.

Keep organization-specific domains, account identifiers, private image
registries, Secret contents, OAuth credentials, private JWKS material, and
deployment overlays out of the public repository.

## Related references

- [Backend registry](backend-registry.md)
- [Quickstart](quickstart.md)
- [External governing platform integration](external-platform-issuer.md)
- [Provider connection flows](provider-connection-flows.md)
- [Provider connection lifecycle](provider-connection-lifecycle.md)
- [Client integration runbook](client-integration-runbook.md)
- [Build from source and verify artifacts](build-from-source.md)
- [Helm chart README](../deploy/k8s/chart/README.md)
