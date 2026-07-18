# Changelog

All notable project changes are tracked here.

This project uses SemVer for source, deployment templates, and public operational contracts. The
GitHub release notes for each tag are generated from merged pull requests; this file records the
human-maintained compatibility summary.

## [Unreleased]

- No unreleased changes yet.

## [0.2.0] - 2026-07-18

- Added optional official GitHub MCP backend bundling through the MCP-GW backend registry.
- Added GitHub OAuth connection routes, per-user GitHub token storage, OAuth status/start helper
  tools, and compatibility aliases for client-owned GitHub tool surfaces.
- Added exact-name shared backend federation support for agentgateway with `prefixMode: never`,
  allowing multiple MCP backends to share one `/mcp` route without forced prefixes.
- Added streamable HTTP/SSE tool-list merging for the GitHub wrapper so local OAuth helper tools
  remain advertised after GitHub is connected.
- Added generic provider connection flow documentation for clients that integrate with MCP-GW
  without a bundled application control plane.
- Pinned the required ApeLogic agentgateway fork version containing multi-provider MCP
  authentication and exact-name routing support.
- Improved DEV, Compose, Kubernetes, and local smoke-test coverage for optional GitHub and
  federated backend deployments.

## [0.1.0] - 2026-07-08

- Initial public OSS release foundation for MCP Gateway.
- Google Workspace MCP wrapper with per-user Google OAuth token storage.
- Agentgateway front door for remote MCP authentication and protected-resource metadata.
- Docker Compose, AWS DEV Compose host, Terraform, Ansible, Helm, Flux, and Argo deployment
  templates.
- Generated Google Workspace `gws_*` tool catalog with curated default service families.
- Optional Google Workspace YAML policy file and external OPA policy integration.

[Unreleased]: https://github.com/apelogic-ai/mcp-gw/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/apelogic-ai/mcp-gw/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/apelogic-ai/mcp-gw/releases/tag/v0.1.0
