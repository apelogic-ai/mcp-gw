import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

describe("GitHub MCP bundled backend", () => {
  test("keeps GitHub out of the default shared MCP route", async () => {
    const descriptor = await readFile("servers/github-mcp/backend.yaml", "utf8");
    const base = await readFile("gateway/agentgateway/base.yaml", "utf8");
    const federated = await readFile("gateway/agentgateway/federated.yaml", "utf8");

    expect(descriptor).toContain("name: github-mcp");
    expect(descriptor).toContain("host: http://github-wrapper:8080/mcp");
    expect(descriptor).toContain("toolPrefix: github");
    expect(descriptor).toContain("enabledByDefault: false");
    expect(base).not.toContain("name: github");
    expect(federated).toContain("name: github");
    expect(federated).not.toContain("name: github-mcp");
    expect(federated).toContain("host: http://github-wrapper:8080/mcp");
  });

  test("defines a runtime-only Compose profile for the GitHub wrapper and official upstream server", async () => {
    const override = await readFile("deploy/compose/docker-compose.github-mcp.yaml", "utf8");
    const readme = await readFile("servers/github-mcp/README.md", "utf8");

    expect(override).not.toContain("gateway/agentgateway/federated.yaml");
    expect(override).not.toContain("/etc/agentgateway/config.yaml");
    expect(override).toContain("github-wrapper:");
    expect(override).toContain("dockerfile: servers/github-mcp/wrapper/Dockerfile");
    expect(override).toContain("GITHUB_MCP_UPSTREAM_URL");
    expect(override).toContain("GITHUB_TOKEN_ENCRYPTION_KEY");
    expect(override).toContain("TOKEN_STORE_DSN");
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
    expect(override).toContain("github-wrapper");
    expect(readme).toContain("ghcr.io/github/github-mcp-server:v1.6.0");
    expect(readme).toContain("runtime-only");
    expect(readme).toContain("does not replace the agentgateway config");
    expect(readme).toContain("Authorization");
    expect(readme).toContain("Credential Boundary");
  });
});
