import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";

describe("build-from-source and artifact verification documentation", () => {
  test("documents every release build or mirror input and links the guide", async () => {
    const [guide, readme, contributing] = await Promise.all([
      readFile("docs/build-from-source.md", "utf8"),
      readFile("README.md", "utf8"),
      readFile("CONTRIBUTING.md", "utf8"),
    ]);

    expect(readme).toContain("docs/build-from-source.md");
    expect(contributing).toContain("docs/build-from-source.md");
    expect(guide).toContain("bun install --frozen-lockfile");
    expect(guide).toContain("scripts/resolve-agentgateway-source.ts");
    expect(guide).toContain("servers/google-workspace/wrapper/Dockerfile");
    expect(guide).toContain("servers/github-mcp/wrapper/Dockerfile");
    expect(guide).toContain("servers/generic-wrapper/Dockerfile");
    expect(guide).toContain("scripts/resolve-github-mcp-source.ts");
    expect(guide).toContain("oras cp --recursive");
    expect(guide).toContain("helm package deploy/k8s/chart");
    expect(guide).toContain("dbMcp");
    expect(guide).toMatch(/not (?:a )?published release artifact/i);
  });

  test("routes each artifact to the correct verification mechanism", async () => {
    const guide = await readFile("docs/build-from-source.md", "utf8");

    expect(guide).toContain("gh attestation verify");
    expect(guide).toContain("oci://ghcr.io/apelogic-ai/mcp-gw-agentgateway@");
    expect(guide).toContain("oci://ghcr.io/apelogic-ai/mcp-gw-google-workspace@");
    expect(guide).toContain("oci://ghcr.io/apelogic-ai/mcp-gw-github-wrapper@");
    expect(guide).toContain("oci://ghcr.io/apelogic-ai/mcp-gw-generic-wrapper@");
    expect(guide).toContain("oci://ghcr.io/apelogic-ai/charts/mcp-gateway@");
    expect(guide).toContain("--repo apelogic-ai/mcp-gw");
    expect(guide).toContain("--cert-identity");
    expect(guide).toMatch(/do not use `cosign verify`/i);
    expect(guide).toMatch(/404/);
    expect(guide).toContain("mcp-gw-github-mcp-server");
    expect(guide).toMatch(/digest equality/i);
    expect(guide).toContain("cosign verify \\");
    expect(guide).toContain("github/github-mcp-server/.github/workflows/docker-publish.yml");
    expect(guide).toMatch(/does not have an MCP-GW build-provenance attestation/i);
  });
});
