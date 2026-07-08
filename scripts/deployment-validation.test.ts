import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";

import { describe, expect, test } from "bun:test";

describe("deployment validation scripts", () => {
  test("exposes scriptable compose, infra, and k8s checks", async () => {
    await expectExecutable("scripts/check-compose.sh");
    await expectExecutable("scripts/check-infra.sh");
    await expectExecutable("scripts/check-k8s.sh");

    const packageJson = await readFile("package.json", "utf8");
    expect(packageJson).toContain('"infra:check": "bash scripts/check-infra.sh"');
    expect(packageJson).toContain('"k8s:check": "bash scripts/check-k8s.sh"');
    expect(packageJson).toContain("bun run compose:check");
    expect(packageJson).toContain("bun run infra:check");
    expect(packageJson).toContain("bun run k8s:check");
  });

  test("wires deployment validation into GitHub Actions", async () => {
    const workflow = await readFile(".github/workflows/ci.yml", "utf8");

    expect(workflow).toContain("hashicorp/setup-terraform");
    expect(workflow).toContain("azure/setup-helm");
    expect(workflow).toContain("pipx install ansible-core");
    expect(workflow).toContain("bun run deploy:check");
    expect(workflow).toContain("bun run integration:local");
  });
});

async function expectExecutable(path: string): Promise<void> {
  await access(path, constants.X_OK);
}
