# Releases

MCP Gateway is intended to be forked, pinned, mirrored, and deployed by enterprise teams. Releases
give those teams a stable source and deployment-template boundary to promote through their own
environments.

## Versioning

Use SemVer:

- `MAJOR`: breaking changes to public deployment shape, MCP endpoint behavior, environment variable
  names, policy semantics, or documented admin workflows.
- `MINOR`: backward-compatible features such as new backend registry fields, new Google Workspace
  tools, new deployment examples, or new optional policy integrations.
- `PATCH`: bug fixes, documentation fixes, test improvements, and non-breaking deployment-template
  corrections.

The current initial public release line is `v0.1.0`.

## Release Artifacts

Each release should provide:

- an annotated Git tag named `vX.Y.Z`;
- a GitHub Release generated from that tag;
- the source archive GitHub attaches to the release;
- the matching Helm chart, Compose files, Terraform, and Ansible templates from that tag;
- release notes calling out operator-impacting changes and required migration steps.

Container images are intentionally not part of the first release contract. Enterprises can build from
the release tag, mirror images into private registries, and pin private image digests in their
overlays. Public image publishing and signing can be added once the registry, provenance, and support
model are decided.

The deployment templates also pin the required `agentgateway` fork version. For the `v0.1.x`
release line, use `ghcr.io/apelogic-ai/agentgateway:v2026.07.17-apelogic.1` or an internally
rebuilt image from the same fork revision. Older upstream images do not contain the MCP
multi-provider authentication and `prefixMode: never` behavior this gateway expects.

## Cutting A Release

1. Start from a clean `main`.
2. Update `package.json` to the target SemVer version.
3. Move relevant `CHANGELOG.md` entries from `Unreleased` to the target version.
4. Run local gates:

   ```bash
   bun install
   bun run ci
   bun run deploy:check
   bun run release:check
   ```

5. Commit the version and changelog update.
6. Create and push an annotated tag:

   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

7. Wait for the `Release` workflow to pass. It reruns CI and deployment-template checks, then creates
   the GitHub Release with generated notes.

## Forking Guidance

Downstream enterprise forks should pin upstream tags, not moving branches, when promoting to internal
environments. Private overlays should remain outside this public repository and should pin images by
digest after the organization rebuilds or mirrors the release artifacts.
