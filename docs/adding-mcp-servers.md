# Adding MCP Servers to MCP-GW

Status: public integration contract

This guide is for external developers and platform integrators who want to add
an MCP server behind MCP-GW's shared `/mcp` endpoint. It covers servers that
already speak MCP over HTTP, external container images, hosted MCP services,
CLI or stdio servers that need an HTTP wrapper, and integrations that need a
credential or policy wrapper.

MCP-GW is a federating gateway, not a universal process supervisor. The public
endpoint is owned by AgentGateway. Each configured backend must ultimately be
reachable as a Streamable HTTP MCP endpoint. The Helm chart can route to an
arbitrary endpoint, but it does not deploy an arbitrary image or automatically
adapt stdio, credentials, OAuth, policy, or tool names for that endpoint.

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

| Backend shape                                                                                                        | Recommended integration                                                                  | Why                                                                                               |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Existing in-cluster Streamable HTTP server that accepts the configured HOP-1 token                                   | Add a direct `agentgateway.backends` target                                              | No protocol or credential translation is needed.                                                  |
| External container image with Streamable HTTP support                                                                | Deploy it with its own chart or manifests, then add its Service URL as a backend         | `agentgateway.backends` configures routing only; it does not create arbitrary workloads.          |
| Externally hosted MCP server that is trusted to receive and validate HOP-1                                           | Add its HTTPS URL as a backend                                                           | AgentGateway can connect directly when the identity and trust contracts already match.            |
| Externally hosted server that expects an API key, provider OAuth token, or its own bearer                            | Put a credential or policy wrapper in front of it                                        | Generic targets cannot inject per-backend secrets or exchange the caller token.                   |
| CLI or stdio server                                                                                                  | Build a Streamable HTTP wrapper and containerize both                                    | AgentGateway cannot launch or speak stdio to a backend.                                           |
| Server whose tools need per-user provider OAuth, argument-aware policy, audit, aliases, or a stable governed catalog | Build a provider-aware wrapper                                                           | Those controls live in wrappers, not in generic target routing.                                   |
| New first-party integration maintained and released by MCP-GW                                                        | Add the wrapper/server, descriptor, deployment contract, tests, docs, and release inputs | A repository integration has compatibility and supply-chain obligations beyond a private overlay. |

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
token. The generic chart target has no supported field for a static
`Authorization` header, API key, client secret, or per-user token exchange.
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

## Wrapper SDK status

MCP-GW does not currently publish a supported wrapper SDK, npm package, or
code-generator. The repository contains a private, structured TypeScript
package at [`packages/wrapper-kit`](../packages/wrapper-kit) for the bundled
wrappers. It defines internal interfaces for HOP-1 authentication, credential
bridges, policy and audit assembly, HTTP proxying, server-side tool registries,
lifecycle routes, and sanitized errors. They are internal source modules rather than stable external APIs.
Their import paths and interfaces may change with MCP-GW itself.

The closest reference implementations are:

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
configuration parsing and provider extension points. It would also ship a
conformance test kit. Unless that supported package is named in MCP-GW release
notes, integrators should treat `packages/wrapper-kit` as implementation detail
rather than an SDK dependency.

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

## Compatibility acceptance checklist

Test the exact deployed topology, not only the backend in isolation.

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
