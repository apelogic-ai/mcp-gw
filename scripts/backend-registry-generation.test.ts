import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

describe("backend registry config generation", () => {
  test("wires backend config drift checks into deployment validation", async () => {
    const packageJson = await readFile("package.json", "utf8");

    expect(packageJson).toContain(
      '"backends:check": "bun scripts/generate-agentgateway-config.ts --check"',
    );
    expect(packageJson).toContain("bun run backends:check");
  });

  test("keeps optional db-mcp out of base config but in federated config", async () => {
    const dbDescriptor = await readFile("servers/db-mcp/backend.yaml", "utf8");
    const base = await readFile("gateway/agentgateway/base.yaml", "utf8");
    const federated = await readFile("gateway/agentgateway/federated.yaml", "utf8");

    expect(dbDescriptor).toContain("enabledByDefault: false");
    expect(base).not.toContain("name: db");
    expect(federated).toContain("name: db");
  });

  test("renders agentgateway multiplex controls for optional backend resilience", async () => {
    const base = await readFile("gateway/agentgateway/base.yaml", "utf8");
    const federated = await readFile("gateway/agentgateway/federated.yaml", "utf8");

    expect(base).not.toContain("prefixMode: always");
    expect(base).toContain("failureMode: failOpen");
    expect(base).toContain("name: google");
    expect(base).not.toContain("name: google-workspace");

    expect(federated).not.toContain("prefixMode: always");
    expect(federated).toContain("failureMode: failOpen");
    expect(federated).toContain("name: google");
    expect(federated).toContain("name: github");
    expect(federated).toContain("name: db");
    expect(federated).not.toContain("name: github-mcp");
    expect(federated).not.toContain("name: db-mcp");
  });

  test("documents the public backend onboarding contract", async () => {
    const guide = await readFile("docs/backend-registry.md", "utf8");

    expect(guide).toContain("servers/<backend>/backend.yaml");
    expect(guide).toContain("bun scripts/generate-agentgateway-config.ts");
    expect(guide).toContain("agentgateway.backends");
    expect(guide).toContain("failureMode: failOpen");
    expect(guide).toContain("Agentgateway prefixes tools when more than one MCP target is active");
    expect(guide).toContain("Do not commit runtime secrets");
  });
});
