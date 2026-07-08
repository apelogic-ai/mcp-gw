---
name: mcp-gw-release
description: Use when cutting, preparing, or reviewing MCP Gateway releases, including SemVer bumps, changelog updates, release PRs, tag creation, GitHub Releases, and enterprise fork/operator release notes.
---

# MCP Gateway Release

Use this skill when preparing a release or reviewing whether a release is ready.

## Release Model

MCP Gateway releases are enterprise-consumable source and deployment-template snapshots. They are not
SaaS deploy markers.

Treat a release as the boundary an organization can:

- fork or mirror;
- scan and audit;
- build into private images;
- pin in Helm, Flux, Argo CD, Terraform, Ansible, and Docker Compose workflows;
- promote through internal environments.

## Versioning

Use SemVer:

- `MAJOR`: breaking deployment, policy, auth, endpoint, env var, or documented operator workflow
  changes.
- `MINOR`: backward-compatible capabilities, backend additions, policy features, tools, or deployment
  examples.
- `PATCH`: fixes, documentation, tests, and non-breaking deployment corrections.

Tags are annotated and named `vX.Y.Z`. `package.json` stores `X.Y.Z` without the leading `v`.

## Required Checks

Before a release PR is ready:

```bash
bun install
bun run ci
bun run deploy:check
bun run integration:local
bun run release:check
```

If any check fails, fix the release branch before tagging.

## Release PR

For a release PR:

1. Start from a clean, current `main`.
2. Update `package.json` to the target version.
3. Move `CHANGELOG.md` entries from `Unreleased` to `## [X.Y.Z] - YYYY-MM-DD`.
4. Ensure `docs/releases.md` still describes the release process.
5. Keep all org-specific domains, secrets, private image digests, OAuth client IDs, and private
   overlays out of public files.
6. Open a PR with the verification commands above.

Do not create the tag from an unmerged feature branch unless the user explicitly asks for a prerelease
or test release.

## Tagging

After the release PR is merged:

```bash
git switch main
git pull --ff-only
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

The `Release` workflow reruns quality gates, deployment validation, local MCP integration smoke, and
release metadata validation before creating the GitHub Release.

## Release Notes

Generated GitHub Release notes are acceptable, but operator-impacting changes must also be clear in
`CHANGELOG.md`.

Call out:

- breaking auth, policy, env var, deployment, or tool-surface changes;
- migrations or re-auth/reconnect requirements;
- new optional services such as OPA;
- known limitations and manual enterprise actions.

Do not include private DEV hostnames, secrets, customer domains, internal account IDs, private
artifact bucket names, or live OAuth credentials.
