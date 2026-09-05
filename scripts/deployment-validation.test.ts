import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";

import { describe, expect, test } from "bun:test";

describe("deployment validation scripts", () => {
  test("exposes scriptable local Compose and Kubernetes product checks", async () => {
    await expectExecutable("scripts/check-compose.sh");
    await expectExecutable("scripts/check-k8s.sh");

    const packageJson = await readFile("package.json", "utf8");
    expect(packageJson).not.toContain("infra:check");
    expect(packageJson).not.toContain("deploy:dev");
    expect(packageJson).toContain('"k8s:check": "bash scripts/check-k8s.sh"');
    expect(packageJson).toContain("bun run compose:check");
    expect(packageJson).toContain("bun run k8s:check");
  });

  test("wires deployment validation into GitHub Actions", async () => {
    const [ciWorkflow, releaseWorkflow] = await Promise.all([
      readFile(".github/workflows/ci.yml", "utf8"),
      readFile(".github/workflows/release.yml", "utf8"),
    ]);

    expect(ciWorkflow).toContain("azure/setup-helm");
    expect(ciWorkflow).not.toContain("hashicorp/setup-terraform");
    expect(ciWorkflow).not.toContain("pipx install ansible-core");
    expect(ciWorkflow).toContain("bun run deploy:check");
    expect(ciWorkflow).toContain("Run Linux broker integration smoke");
    expect(ciWorkflow).toContain("bun run integration:local");
    expect(releaseWorkflow).toContain("bun run integration:local");
    expect(releaseWorkflow).toContain("bun run integration:k8s");
  });

  test("pins third-party GitHub Actions by immutable commit SHA", async () => {
    const workflows = await Promise.all([
      readFile(".github/workflows/ci.yml", "utf8"),
      readFile(".github/workflows/release.yml", "utf8"),
    ]);
    const actionUses = workflows
      .flatMap((workflow) => workflow.match(/uses:\s*[^@\s]+@[^\s]+/g) ?? [])
      .map((match) => match.replace(/^uses:\s*/, ""));

    expect(actionUses.length).toBeGreaterThan(0);
    for (const use of actionUses) {
      expect(use).toMatch(/@[a-f0-9]{40}$/);
    }
  });
});

async function expectExecutable(path: string): Promise<void> {
  await access(path, constants.X_OK);
}
