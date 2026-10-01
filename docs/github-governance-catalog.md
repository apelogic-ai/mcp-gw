# GitHub Governance Catalog

Each MCP-GW release publishes `github-governance-catalog.json` as a GitHub Release asset. The file
is generated from the same pinned catalog that the GitHub wrapper uses at runtime; it is not a
separately maintained tool list.

The top-level `catalogId` identifies the upstream GitHub MCP Server release, while
`wrapperCatalogId` identifies the wrapper's exact all-toolsets contract. The `source` object pins
the upstream OCI repository, tag, and immutable digest. A consumer should reject an unsupported
`schemaVersion`, unexpected catalog identity, or unexpected source digest.

## Contents

- `chartDefaultToolsets` is the expanded toolset selection shipped by the Helm and Compose defaults.
- `tools` contains every pinned tool, all of its toolset memberships, every action class the wrapper
  can resolve for it, the upstream `readOnlyHint`, and whether the chart enables it by default.
- `grants` contains every selectable `(provider, resource, action)` tuple. `accessClass` repeats the
  wrapper-resolved `action` as one of `read`, `write`, or `destructive`; `toolsets` preserves every
  membership rather than selecting an arbitrary primary group; and `chartDefaultEnabled` states
  whether the shipped chart exposes the resource.

`chartDefaultEnabled` describes the release default, not an installation override. If
`githubMcp.env.GITHUB_TOOLSETS` is changed, filter the catalog by the configured toolsets instead.
The artifact is descriptive metadata: it does not grant authority. The wrapper still classifies the
actual operation and enforces the exact tuple carried by the caller's policy/token path.

## Capability-catalog mapping

To produce an all-read `steward.capability-catalog/v2` document, map every read grant without
rewriting its authority tuple:

```bash
jq '{
  schemaVersion: "steward.capability-catalog/v2",
  models: [],
  tools: [
    .grants[]
    | select(.accessClass == "read")
    | {
        provider,
        resource,
        action,
        accessClass,
        toolsets
      }
  ]
}' github-governance-catalog.json > capability-catalog.json
```

For the shipped chart surface, add `and .chartDefaultEnabled` to the `select` expression. The pinned
v1.6.0 catalog currently contains 54 all-toolsets read tuples and 40 chart-default read tuples.

The authority-bearing Mint claim contains only the exact tuples:

```bash
jq '{
  "steward": {
    tools: [.tools[] | {provider, resource, action}]
  }
}' capability-catalog.json
```

Do not infer a broader action from `upstreamReadOnlyHint`, collapse multiple toolset memberships, or
turn `accessClass` metadata into a different grant. Write and destructive tuples require explicit
selection.

## Verification

Download both `github-governance-catalog.json` and `github-governance-catalog.digest` from the same
release. Compare the file's SHA-256 digest with the recorded digest, then verify its GitHub
Attestation against the tagged release workflow:

```bash
test "$(cat github-governance-catalog.digest)" = \
  "sha256:$(sha256sum github-governance-catalog.json | awk '{print $1}')"

gh attestation verify github-governance-catalog.json \
  --repo apelogic-ai/mcp-gw \
  --cert-identity \
    "https://github.com/apelogic-ai/mcp-gw/.github/workflows/release.yml@refs/tags/vX.Y.Z"
```

The release workflow performs the same verification before creating the GitHub Release.
