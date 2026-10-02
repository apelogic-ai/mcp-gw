# Contributing to MCP-GW

Thank you for improving MCP-GW. Bug reports, focused pull requests, documentation fixes, and
provider-neutral design proposals are welcome.

## Before opening an issue

- Search existing issues and release notes first.
- Do not disclose vulnerabilities, credentials, tokens, or personal data in a public issue. Follow
  [SECURITY.md](SECURITY.md) instead.
- Include the affected version, deployment mode, expected behavior, actual behavior, and a minimal
  redacted reproduction.

## Development workflow

1. Fork the repository and create a focused topic branch.
2. Install the pinned dependencies with `bun install`.
3. Add or update tests before changing behavior.
4. Run the standard gates:

   ```bash
   bun run ci
   bun run deploy:check
   ```

5. Keep deployment examples generic. Never commit real domains, OAuth credentials, token-store
   contents, private keys, cloud identifiers, or environment-specific overlays.
6. Describe operator impact, compatibility, migrations, and validation evidence in the pull
   request.

Changes to public APIs, authentication, policy, provider lifecycle, chart values, or release
artifacts should include corresponding contract documentation and upgrade notes.

Changes to container or release inputs must keep the reproducible commands and verification paths in
[docs/build-from-source.md](docs/build-from-source.md) current.

New MCP backend integrations must follow the transport, identity, tool namespace, policy, testing,
and packaging contract in [docs/adding-mcp-servers.md](docs/adding-mcp-servers.md). A private Helm
backend target does not require a source-tree descriptor; a first-party backend contribution does.

## Pull requests

Keep one coherent change per pull request. Maintainers may ask for changes to preserve
provider-neutral behavior, fail-closed security properties, stable tool catalogs, or release
compatibility. By contributing, you agree that your contribution is licensed under this
repository's MIT license.
