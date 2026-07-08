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
    expect(base).not.toContain("name: db-mcp");
    expect(federated).toContain("name: db-mcp");
  });

  test("documents the public backend onboarding contract", async () => {
    const guide = await readFile("docs/backend-registry.md", "utf8");

    expect(guide).toContain("servers/<backend>/backend.yaml");
    expect(guide).toContain("bun scripts/generate-agentgateway-config.ts");
    expect(guide).toContain("agentgateway.backends");
    expect(guide).toContain("Do not commit runtime secrets");
  });
});
