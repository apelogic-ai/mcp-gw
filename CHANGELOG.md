# Changelog

All notable project changes are tracked here.

This project uses SemVer for source, deployment templates, and public operational contracts. The
GitHub release notes for each tag are generated from merged pull requests; this file records the
human-maintained compatibility summary.

## [Unreleased]

- No unreleased changes yet.

## [0.1.0] - 2026-07-08

- Initial public OSS release foundation for MCP Gateway.
- Google Workspace MCP wrapper with per-user Google OAuth token storage.
- Agentgateway front door for remote MCP authentication and protected-resource metadata.
- Docker Compose, AWS DEV Compose host, Terraform, Ansible, Helm, Flux, and Argo deployment
  templates.
- Generated Google Workspace `gws_*` tool catalog with curated default service families.
- Optional Google Workspace YAML policy file and external OPA policy integration.

[Unreleased]: https://github.com/apelogic-ai/mcp-gw/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/apelogic-ai/mcp-gw/releases/tag/v0.1.0
