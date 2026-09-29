# AgentGateway compatibility source

MCP-GW builds its AgentGateway image from the compatibility fork and immutable
commit declared in [`.release/agentgateway-source.json`](../.release/agentgateway-source.json).
That file is the only source pin: pull-request CI and tagged releases resolve it
with `scripts/resolve-agentgateway-source.ts`, build the same source tree, and
record the fork URL and commit in the image's OCI metadata. A branch name,
release tag, or previously published image is not a substitute for the pin.

## Compatibility patch set

The pinned fork carries six MCP-GW compatibility changes beyond its upstream
base:

1. [multi-provider MCP authentication](https://github.com/apelogic-ai/agentgateway/pull/1);
2. [release and controller security hardening](https://github.com/apelogic-ai/agentgateway/pull/2);
3. [`prefixMode: never` behavior alongside multi-provider authentication](https://github.com/apelogic-ai/agentgateway/pull/3);
4. [failure isolation between provider JWKS sources](https://github.com/apelogic-ai/agentgateway/pull/4);
   and
5. [generic HOP-1 issuer profiles](https://github.com/apelogic-ai/agentgateway/pull/5),
   including algorithm allowlists and optional token introspection; and
6. [remote JWKS recovery and rotation refetch](https://github.com/apelogic-ai/agentgateway/pull/6),
   including startup-failure retries and bounded unknown-key refreshes.

These patches are required by the generated AgentGateway configuration and the
authentication contract documented in this repository. Do not update the pin
merely because upstream `main` advanced.

## Upstream sync procedure

1. Compare the pinned fork commit with the current upstream repository and
   identify upstreamed, conflicting, and still-required compatibility patches.
2. Create a fork branch from the selected upstream commit and port only the
   still-required patches. Keep the fork history reviewable; do not merge
   upstream blindly into the release pin.
3. Run the fork's unit and integration gates, then point an MCP-GW pull request
   at the candidate commit and run the complete MCP-GW CI, Compose integration,
   and Kubernetes smoke suites.
4. Review generated configuration compatibility and verify the candidate
   binary version plus OCI `source` and `revision` metadata identify the fork
   and candidate commit.
5. Change only `.release/agentgateway-source.json` after those checks pass.
   Merge that change through the normal MCP-GW review process before using it
   in a release.

When a compatibility patch is accepted upstream, remove it from this list and
from the fork during the next sync. The long-term goal is an empty patch set and
a direct immutable upstream pin.
