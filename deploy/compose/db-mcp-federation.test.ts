import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

describe("db-mcp federation backend", () => {
  test("keeps db-mcp out of the base gateway config and adds it only in federated config", async () => {
    const base = await readFile("gateway/agentgateway/base.yaml", "utf8");
    const federated = await readFile("gateway/agentgateway/federated.yaml", "utf8");

    expect(base).toContain("name: google-workspace");
    expect(base).not.toContain("name: db-mcp");
    expect(federated).toContain("name: google-workspace");
    expect(federated).toContain("name: db-mcp");
    expect(federated).toContain("host: http://db-mcp:8080/mcp");
    expect(federated).toContain("mcp:");
    expect(federated).toContain("targets:");
  });

  test("defines an optional db-mcp compose override using HTTP MCP transport", async () => {
    const override = await readFile("deploy/compose/docker-compose.db-mcp.yaml", "utf8");
    const dockerfile = await readFile("servers/db-mcp/Dockerfile", "utf8");
    const backend = await readFile("servers/db-mcp/backend.yaml", "utf8");

    expect(override).toContain("db-mcp:");
    expect(override).toContain('profiles: ["db-mcp"]');
    expect(override).toContain("context: ${DB_MCP_REPO_PATH:-../../../db-mcp}");
    expect(override).toContain("MCP_TRANSPORT: http");
    expect(override).toContain("MCP_HOST: 0.0.0.0");
    expect(override).toContain('MCP_PORT: "8080"');
    expect(override).toContain("MCP_PATH: /mcp");
    expect(override).toContain("gateway/agentgateway/federated.yaml");
    expect(dockerfile).toContain("uv sync --frozen --package db-mcp-server");
    expect(dockerfile).toContain('CMD ["uv", "run", "db-mcp-server"]');
    expect(backend).toContain("name: db-mcp");
  });
});
