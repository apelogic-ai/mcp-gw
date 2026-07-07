# MCP Gateway and Google Workspace Architecture

Status: public architecture note

This repository provides an org-controlled MCP endpoint for Google Workspace tools. The intent is to
give MCP clients a single gateway URL while keeping identity, Google credentials, tool policy, and
audit under the operator's control.

## Components

- **agentgateway:** public MCP front door, OAuth protected-resource metadata, route/federation
  configuration, and edge authentication.
- **Google Workspace wrapper:** HTTP MCP server that validates caller identity, maps the caller to a
  Google OAuth account, enforces policy, audits tool calls, and invokes `gws`.
- **gws CLI:** stateless Google Workspace execution engine. It receives a per-call Google access
  token through `GOOGLE_WORKSPACE_CLI_TOKEN`.
- **Token store:** Postgres-compatible storage for OAuth state and encrypted Google refresh tokens.

## Credential Model

The system separates caller identity from Google Workspace authorization:

- **HOP-1:** client-to-gateway identity token. The issuer and audience are configured per
  deployment.
- **HOP-2:** per-user Google OAuth grant. The wrapper stores encrypted refresh tokens and mints
  short-lived access tokens for Google API calls.

The HOP-1 token is used only to identify and authorize the caller. It is not a Google credential and
is never passed to `gws`.

## Tool Surface

The default tool surface is focused on Google Workspace collaboration products:

- Drive
- Gmail
- Calendar
- Docs
- Sheets
- Slides
- Tasks
- limited Meet operations
- workflow helpers

The generated catalog is filtered to avoid exposing admin, Chat, Classroom, Cloud Platform,
contacts/directory, Forms, Keep, Groups, Apps Script, and user-profile-detail scopes by default.
Deployments can intentionally fork or reconfigure the surface, but public defaults should remain
reviewable and consentable.

## Policy and Audit

The wrapper is the policy boundary for Google-specific behavior because it sees the authenticated
principal, MCP tool name, arguments, requested Google scopes, and Google response. Policy is designed
to run before token lookup and execution. Audit events record the principal, tool, argument digest,
decision, status, latency, and result size without storing raw tokens.

## Deployment Shapes

- Docker Compose for local and DEV-style deployments.
- Terraform and Ansible for a single AWS Compose host.
- Helm chart templates for Kubernetes.

Only the gateway should be public. Backend wrappers and token stores should remain private network
services.
