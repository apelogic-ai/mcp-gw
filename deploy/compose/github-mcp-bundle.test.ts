import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

describe("GitHub MCP bundled backend", () => {
  test("registers official GitHub MCP as an optional federated backend", async () => {
    const descriptor = await readFile("servers/github-mcp/backend.yaml", "utf8");
    const base = await readFile("gateway/agentgateway/base.yaml", "utf8");
    const federated = await readFile("gateway/agentgateway/federated.yaml", "utf8");

    expect(descriptor).toContain("name: github-mcp");
    expect(descriptor).toContain("host: http://github-mcp:8082/mcp");
    expect(descriptor).toContain("toolPrefix: github");
    expect(descriptor).toContain("enabledByDefault: false");
    expect(base).not.toContain("name: github-mcp");
    expect(federated).toContain("name: github-mcp");
    expect(federated).toContain("host: http://github-mcp:8082/mcp");
  });

  test("defines a Compose profile for the official GitHub MCP server", async () => {
    const override = await readFile("deploy/compose/docker-compose.github-mcp.yaml", "utf8");
    const readme = await readFile("servers/github-mcp/README.md", "utf8");

    expect(override).toContain("github-mcp:");
    expect(override).toContain('profiles: ["github-mcp"]');
    expect(override).toContain(
      "image: ${GITHUB_MCP_IMAGE:-ghcr.io/github/github-mcp-server:v1.6.0}",
    );
    expect(override).toContain("http");
    expect(override).toContain("--port");
    expect(override).toContain("8082");
    expect(override).toContain("--base-path");
    expect(override).toContain("/mcp");
    expect(override).toContain("GITHUB_TOOLSETS");
    expect(override).not.toContain("GITHUB_PERSONAL_ACCESS_TOKEN");
    expect(override).toContain("gateway/agentgateway/federated.yaml");
    expect(readme).toContain("ghcr.io/github/github-mcp-server:v1.6.0");
    expect(readme).toContain("Authorization");
    expect(readme).toContain("Credential Boundary");
  });
});
