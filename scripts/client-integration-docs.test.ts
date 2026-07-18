import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

describe("client integration documentation", () => {
  test("documents enterprise MCP-GW integration without naming private client apps", async () => {
    const [readme, runbook] = await Promise.all([
      readFile("README.md", "utf8"),
      readFile("docs/client-integration-runbook.md", "utf8"),
    ]);

    expect(readme).toContain("docs/client-integration-runbook.md");
    expect(runbook).toContain("Status: public enterprise template");
    expect(runbook).toContain("Claude");
    expect(runbook).toContain("Codex");
    expect(runbook).toContain("HOP-1");
    expect(runbook).toContain("HOP-2");
    expect(runbook).toContain("Provider Connection Flows");
    expect(runbook).toContain("Do not commit");
    expect(runbook.toLowerCase()).not.toContain(`bur${"ble"}`);
  });
});
