# Implementation Plan

Status: public project plan

This plan captures the implementation shape without deployment-specific or private environment
details.

## Decisions

- Stack: Bun and TypeScript for the gateway support code and Google Workspace wrapper.
- HOP-1 identity: configurable OIDC/JWKS issuer profiles.
- HOP-2 Google access: per-user OAuth consent with encrypted refresh-token storage.
- Runtime: remote MCP over HTTP through `agentgateway`.
- Google execution: `@googleworkspace/cli` invoked as a subprocess with a per-call
  `GOOGLE_WORKSPACE_CLI_TOKEN`.
- Federation: Google Workspace is the first backend; additional MCP backends can be registered
  behind the same gateway.
- Testing: strict TDD with local unit tests and static deployment checks.

## Runtime Flow

1. A remote MCP client connects to the public gateway `/mcp` endpoint.
2. The gateway validates the HOP-1 bearer token according to configured issuer profiles.
3. The gateway forwards the MCP request to the selected backend.
4. The Google Workspace wrapper validates the forwarded identity independently.
5. The wrapper resolves the caller's Google OAuth account from the token store.
6. The wrapper refreshes a short-lived Google access token when needed.
7. The wrapper invokes `gws` with only the Google access token in the child environment.
8. The wrapper returns MCP results and emits audit data.

## Implementation Phases

### 0. Project Skeleton

- Bun/TypeScript project.
- Typecheck, lint, format, test, and CI scripts.
- GitHub Actions CI.

### 1. MCP Wrapper Core

- Streamable HTTP MCP request handling.
- `initialize`, `tools/list`, and `tools/call`.
- Stable tool registry interface.
- Structured MCP errors.

### 2. Google Workspace Catalog

- Curated stable tools.
- Generated `gws_*` tools from the pinned `@googleworkspace/cli` registry and Google Discovery
  metadata.
- Filtered default surface for consentable public use.
- Explicit read/write/destructive annotations.

### 3. gws Executor

- Direct subprocess spawn without shell interpolation.
- Per-call access token injection through `GOOGLE_WORKSPACE_CLI_TOKEN`.
- Isolated process environment.
- Timeout, stderr, invalid JSON, and redaction behavior.

### 4. HOP-1 Identity

- Configurable issuer profiles.
- JWKS-backed JWT validation.
- Configurable email and subject claims.
- Multi-issuer support for migration and federated clients.

### 5. HOP-2 OAuth

- OAuth start, callback, status, and disconnect routes.
- CSRF-protected OAuth state storage.
- Postgres-compatible token store.
- Application-level refresh-token encryption.
- Scope upgrade and reconnect handling.

### 6. Policy and Audit

- Policy boundary before token lookup and tool execution.
- OPA-compatible adapter.
- JSONL audit sink for development.
- Redaction and argument digest helpers.

### 7. Deployment Templates

- Docker Compose for local and single-host deployments.
- Terraform and Ansible for an AWS Compose host.
- Helm templates for Kubernetes.

## Data Model

The OAuth persistence layer uses:

- `oauth_accounts` for encrypted Google refresh tokens and granted scopes;
- `oauth_states` for CSRF-protected OAuth flow state.

Audit is currently emitted through sinks rather than stored in the token schema.

## Open Design Areas

- Production license and contribution model.
- Production identity provider migration strategy.
- Production policy language and default deny/allow posture.
- Optional non-Google backend onboarding.
- Long-term replacement or upstreaming strategy for any gateway patches.
