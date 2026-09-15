# mcp-gateway (chart-next)

Same product as `deploy/k8s/chart`, same values keys for every component, same
rendered runtime. What changed is how the chart reaches those objects.

## The one idea

The 0.4.x chart asked the operator for four public URLs — the broker issuer, the
MCP resource, the Google broker callback, and the Ingress host — and then spent
most of `validation.yaml` proving they agreed with each other and with
`agentgateway.mcpAuthentication.resourceMetadata`.

This chart asks for the origin once:

```yaml
routing:
  host: mcp.example.com
  mcpPath: /mcp
  oauthPath: /oauth
```

and derives the rest:

| value | derived as |
| --- | --- |
| MCP resource | `https://mcp.example.com/mcp` |
| resource metadata path | `/.well-known/oauth-protected-resource/mcp` |
| broker issuer | `https://mcp.example.com/oauth` |
| authorization-server metadata | `/.well-known/oauth-authorization-server/oauth` |
| broker callback | `https://mcp.example.com/oauth/google/broker/callback` |
| `resourceMetadata.authorizationServers` | the broker issuer |
| `resourceMetadata.scopesSupported` | the broker scopes |

Nothing cross-checks them because nothing can make them disagree. The same
substitution applies to the AgentGateway MCP targets: they come from the enabled
provider components rather than from a `backends` list that then had to be
checked for containing exactly one entry of each expected name.

What is left of validation lives in `values.schema.json`, which reports the
offending path instead of failing the release with a sentence. Two checks stay
in the templates because they are relationships, not shapes, and both guard the
same thing — that a Google ID token cannot be presented directly at the MCP
resource while the broker is the authorization server.

## Routing

The chart owns the whole public surface, for either router:

| path | backend |
| --- | --- |
| `/mcp`, `/.well-known/oauth-protected-resource/mcp` | agentgateway |
| `/.well-known/oauth-authorization-server/oauth`, `/oauth/authorize`, `/oauth/token`, `/oauth/register`, `/oauth/.well-known/jwks.json`, `/oauth/google/broker/callback` | authorization-broker |
| `/oauth/google/*` | google-workspace |
| `/oauth/github/*` | github-wrapper |

Enable exactly one of `routing.gatewayApi` or `routing.ingress`. In 0.4.x the
Gateway API mode emitted only the broker routes and left `/mcp` to the operator,
which meant a hand-written HTTPRoute carrying the same exact paths as the
chart-managed one. **Delete any hand-written route before upgrading.**

## Secrets

One Secret by default:

```yaml
secrets:
  name: mcp-gateway-secrets
```

It backs every component's `envFrom`, the migration DSN
(`oauthMigrations.secretKeyRef.key`, default `TOKEN_STORE_DSN`) and the broker
signing keyring (`...signingKeyring.secretKeyRef.key`, default
`signing-jwks.json`). Any of them may still name its own Secret.

## NetworkPolicy

Off by default, and no longer a precondition for running the broker. A policy
that the cluster's CNI does not enforce is worse than no policy, because it
reads as a control that is not there — check that the CNI implements
NetworkPolicy before turning it on. When on, each component admits its own
release, and the three public-facing components additionally admit either
`networkPolicy.ingressSourceCidrs` or `networkPolicy.ingressControllerPeer`.

## Upgrading from 0.4.x

Component keys (`agentgateway.image`, `googleWorkspace.env`, `githubWrapper.*`,
`githubMcp.*`, `dbMcp.*`, `hop1.issuers`, `postgresql.caBundle`,
`oauthMigrations.*`) are unchanged. These moved:

| 0.4.x | 0.5.0 |
| --- | --- |
| `agentgateway.ingress.host` | `routing.host` |
| `agentgateway.ingress.{enabled,className,annotations,brokerAnnotations,tls}` | `routing.ingress.*` |
| `agentgateway.ingress.paths` | removed; derived from `routing.mcpPath` |
| `agentgateway.gatewayApi.brokerHttpRoute.*` | `routing.gatewayApi.*`, now covering every public path |
| `agentgateway.backends` | removed; derived from the enabled components. Use `agentgateway.backendOverrides` for host/port/path and `agentgateway.extraBackends` for targets outside the release |
| `agentgateway.mcpAuthentication.resourceMetadata.resource` | removed; derived |
| `agentgateway.mcpAuthentication.resourceMetadata.scopesSupported` | `agentgateway.mcpAuthentication.scopesSupported`, and ignored while the broker is enabled |
| `googleWorkspace.authorizationBroker.{issuer,resource,googleCallbackUri}` | removed; derived |
| `googleWorkspace.authorizationBroker.{ingressControllerPeer,ingressSourceCidrs}` | `networkPolicy.*` |
| `githubWrapper.env.GITHUB_MCP_UPSTREAM_URL` | derived from the githubMcp Service; set it only for an external server |
| `productionProfile` | removed |
| four separate Secret references | `secrets.name` |

Unknown keys are rejected by the schema, so a leftover 0.4.x key fails fast and
by name rather than rendering something subtly different.
