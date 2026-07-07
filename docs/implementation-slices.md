# Implementation slices

Date: 2026-07-03
Status: historical execution plan

This project follows strict TDD: each slice starts with tests or static checks that describe the
desired behavior, then implementation is added until those checks pass. Each completed slice gets its
own commit.

## Slice 0: Project skeleton and quality gates

Goal: establish a Bun/TypeScript repo that can enforce tests, typecheck, lint, format, and CI before
runtime work starts.

Deliverables:

- `package.json` with `test`, `typecheck`, `lint`, `format`, `format:check`, and `ci` scripts.
- Strict `tsconfig.json`.
- ESLint flat config for TypeScript.
- Prettier config and ignore file.
- GitHub Actions CI running Bun install plus all local quality gates.
- Minimal source/test harness with one real smoke test.
- `.gitignore`.

TDD checks:

- A smoke test proves the test runner is wired.
- `bun run ci` is the local equivalent of CI.

## Slice 1: MCP wrapper core skeleton

Goal: build the smallest streamable HTTP MCP wrapper surface without real Google calls.

Deliverables:

- HTTP server entrypoint under `servers/google-workspace/wrapper`.
- MCP JSON-RPC request/response handling for `initialize`, `tools/list`, and `tools/call`.
- Stable tool registry interface.
- Fake in-memory tool for tests only.
- Structured MCP errors.

TDD checks:

- `initialize` returns server metadata.
- `tools/list` returns deterministic tools.
- unknown tools fail with an MCP-shaped error.
- malformed requests fail before tool execution.

## Slice 2: Google Workspace tool catalog

Goal: import the first production Google Workspace catalog shape and command mapping without
executing `gws`.

Deliverables:

- Tool definition model with params, body params, default params, annotations, and scope metadata.
- Initial curated catalog with license attribution notes.
- Coverage docs for Drive, Gmail, Calendar, Docs, Sheets, Tasks, and Meet.

TDD checks:

- Tool names are unique and federation-safe.
- Every tool has an explicit read/write/destructive action class.
- Required params are represented in generated schemas.
- Write/destructive tools are included.

## Slice 3: gws subprocess executor

Goal: safely invoke `gws` with per-call access tokens and isolated process state.

Deliverables:

- Executor interface and implementation.
- Fake `gws` fixture binary/script for tests.
- Timeout, stall timeout, stdout JSON parsing, stderr normalization, and redaction.
- Pinned `gws` packaging strategy.

TDD checks:

- `GOOGLE_WORKSPACE_CLI_TOKEN` is present only in the child environment.
- HOP-1 bearer token is never passed to the child.
- Args are not shell-interpolated.
- bad JSON, nonzero exit, timeout, and stall are normalized.

## Slice 4: HOP-1 identity validation

Goal: validate inbound identity in the wrapper independently from agentgateway.

Deliverables:

- Shared issuer profile abstraction.
- Google OIDC profile for initial deployment.
- Okta-shaped fixture/profile placeholder.
- JWT/JWKS validation module.

TDD checks:

- valid Google token passes.
- wrong issuer, wrong audience, expired token, and missing email fail.
- claim mapping is configurable.

## Slice 5: HOP-2 per-user OAuth consent

Goal: let each authenticated user connect their Google Workspace account and refresh access tokens.

Deliverables:

- OAuth start/callback/status/disconnect routes.
- OAuth state store with CSRF protection.
- Token store interface with Postgres-compatible schema and local dev adapter.
- Application-level refresh-token encryption.
- Scope upgrade flow.

TDD checks:

- auth URL includes offline access, state, redirect URI, login hint, and exact scopes.
- callback rejects bad state.
- connected email must match HOP-1 email by default.
- refresh is deduplicated and revoked tokens require reauth.

## Slice 6: Policy and audit foundation

Goal: enforce org-side policy and emit rich audit independent of client agent behavior.

Deliverables:

- Policy decision interface with allow, deny, and approval-required results.
- OPA-compatible adapter boundary.
- JSONL audit sink for local/dev.
- Redaction and argument digest helpers.

TDD checks:

- policy runs before tool execution.
- denied calls are audited.
- sensitive values are not logged.
- policy behavior does not depend on Claude-specific approvals.

## Slice 7: Docker Compose local and DEV

Goal: run the gateway, wrapper, token store, and optional backends locally and on the AWS DEV box.

Deliverables:

- `deploy/compose/docker-compose.yaml`.
- Google wrapper compose fragment.
- Postgres token store for compose.
- agentgateway config and target registration.
- Makefile or task scripts for up/down/test/smoke.

TDD/checks:

- static config checks validate target files.
- compose smoke reaches wrapper through agentgateway.
- `tools/list` works through the public gateway path.

## Slice 8: db-mcp federation backend

Goal: onboard `db-mcp` as the second backend without changing gateway core.

Deliverables:

- `servers/db-mcp` backend unit.
- compose fragment using db-mcp HTTP MCP transport.
- agentgateway target config with stable prefix.

TDD/checks:

- Google and db-mcp tool names do not collide.
- db-mcp target can be toggled on/off.
- identity reaches db-mcp when enabled.

## Slice 9: Terraform and Ansible

Goal: prepare infrastructure and deployment automation for DEV on the AWS box.

Deliverables:

- Terraform module for required AWS resources around the DEV host, DNS/TLS hooks, security groups,
  and future EKS/RDS boundaries.
- EC2 instance profile with AWS Systems Manager Session Manager enabled as the canonical operator
  access path.
- Public SSH disabled by default, with an explicit `/32` break-glass switch while Ansible deploys
  still use rsync over SSH.
- Temporary DEV OAuth callback uses the Terraform-emitted
  `mcp_gateway_dev_google_oauth_redirect_uri` until stable DNS is assigned.
- Ansible playbook for Docker, compose deployment, env files, secrets handoff, service restart, and
  smoke checks.
- Inventory example for the AWS DEV box.

TDD/checks:

- `terraform fmt -check` and `terraform validate` where credentials are not required.
- `ansible-lint` or syntax checks for playbooks.
- `aws --profile <profile> --region <region> ssm start-session --target <instance-id>` is documented
  and scriptable.
- deployment smoke command is documented and scriptable.

## Slice 10: Kubernetes production shape

Goal: create the EKS-ready chart and render-time safety checks.

Deliverables:

- Umbrella Helm chart.
- Per-server values blocks.
- ExternalSecret, NetworkPolicy, HPA/PDB, Service, Deployment, and Ingress templates.
- Rendered-manifest selector-disjointness check.

TDD/checks:

- Helm templates render.
- only gateway is public.
- selectors are component-scoped.
- wrapper and db-mcp are cluster-internal.
