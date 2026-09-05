import { readFile } from "node:fs/promises";
import { parse } from "yaml";

describe("release metadata", () => {
  const expectedVersion = "0.4.4";

  test("documents the release process and current package version", async () => {
    const [packageJson, changelog, releaseDocs, readme, skill] = await Promise.all([
      readFile("package.json", "utf8"),
      readFile("CHANGELOG.md", "utf8"),
      readFile("docs/releases.md", "utf8"),
      readFile("README.md", "utf8"),
      readFile("skills/mcp-gw-release/SKILL.md", "utf8"),
    ]);

    const parsedPackage = JSON.parse(packageJson) as {
      version: string;
      scripts: Record<string, string>;
    };

    expect(parsedPackage.version).toBe(expectedVersion);
    expect(parsedPackage.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(parsedPackage.scripts["release:check"]).toBe("bun scripts/check-release-metadata.ts");
    expect(changelog).toContain("## [Unreleased]");
    expect(changelog).toContain(`## [${parsedPackage.version}] - 2026-09-05`);
    expect(changelog).toContain(
      `[Unreleased]: https://github.com/apelogic-ai/mcp-gw/compare/v${parsedPackage.version}...HEAD`,
    );
    expect(releaseDocs).toContain("SemVer");
    expect(releaseDocs).toContain(`v${parsedPackage.version}`);
    expect(releaseDocs).toContain("OCI Helm chart");
    expect(releaseDocs).toContain("SBOM");
    expect(releaseDocs).toContain("provenance");
    expect(releaseDocs).toContain("vulnerability report");
    expect(readme).toContain("docs/releases.md");
    expect(skill).toContain("name: mcp-gw-release");
    expect(skill).toContain("bun run release:check");
    expect(skill).toContain("git tag -a vX.Y.Z");
    expect(skill).toContain("Do not include private DEV hostnames");
    expect(skill).toContain("OCI Helm chart");
    expect(skill).toContain("image digests");
  });

  test("runs release metadata checks in CI and on version tags", async () => {
    const [ciWorkflow, releaseWorkflow] = await Promise.all([
      readFile(".github/workflows/ci.yml", "utf8"),
      readFile(".github/workflows/release.yml", "utf8"),
    ]);

    expect(ciWorkflow).toContain("bun run release:check");
    expect(releaseWorkflow).toContain("tags:");
    expect(releaseWorkflow).toContain("v*.*.*");
    expect(releaseWorkflow).toContain("bun run ci");
    expect(releaseWorkflow).toContain("bun run deploy:check");
    expect(releaseWorkflow).toContain("gh release create");
    expect(releaseWorkflow).toContain("--generate-notes");
    expect(releaseWorkflow).toContain("release-handoff.md");
  });

  test("builds candidate and release images only in the release workflow", async () => {
    const [ciWorkflow, releaseWorkflow] = await Promise.all([
      readFile(".github/workflows/ci.yml", "utf8"),
      readFile(".github/workflows/release.yml", "utf8"),
    ]);

    expect(ciWorkflow).toContain("concurrency:");
    expect(ciWorkflow).toContain("cancel-in-progress: true");
    expect(ciWorkflow).toContain("Run Linux broker integration smoke");
    expect(ciWorkflow).toContain("bun run integration:local");
    expect(ciWorkflow).toContain(
      "ghcr.io/apelogic-ai/mcp-gw-agentgateway@sha256:b55af06eccd96e4cf87bde9d4d75f2c45eb70e7768e4989d93ccab3f45db3859",
    );
    expect(ciWorkflow).not.toContain("docker/build-push-action@");
    expect(ciWorkflow).not.toContain("docker/setup-buildx-action@");
    expect(ciWorkflow).not.toContain("arm64-inputs:");
    expect(ciWorkflow).not.toContain("arm64-image-build:");
    expect(ciWorkflow).not.toContain("helm/kind-action@");

    expect(releaseWorkflow).toContain("docker/build-push-action@");
    expect(releaseWorkflow).toContain("runner: ubuntu-24.04-arm");
    expect(releaseWorkflow).toContain("platform: linux/arm64");
    expect(releaseWorkflow).not.toContain("docker/setup-qemu-action@");
  });

  test("keeps Helm chart versions aligned with the package release", async () => {
    const [packageJson, chartYaml] = await Promise.all([
      readFile("package.json", "utf8"),
      readFile("deploy/k8s/chart/Chart.yaml", "utf8"),
    ]);

    const packageVersion = (JSON.parse(packageJson) as { version: string }).version;
    const chart = parse(chartYaml) as {
      version: string;
      appVersion: string;
      annotations: Record<string, string>;
    };

    expect(chart.version).toBe(packageVersion);
    expect(chart.appVersion).toBe(packageVersion);
    expect(chart.annotations["artifacthub.io/images"]).toContain(
      `ghcr.io/apelogic-ai/mcp-gw-agentgateway:${packageVersion}`,
    );
    expect(chart.annotations["artifacthub.io/images"]).toContain(
      `ghcr.io/apelogic-ai/mcp-gw-google-workspace:${packageVersion}`,
    );
    expect(chart.annotations["artifacthub.io/images"]).toContain(
      `ghcr.io/apelogic-ai/mcp-gw-github-wrapper:${packageVersion}`,
    );
    expect(chart.annotations["artifacthub.io/changes"]).toContain("kind: fixed");
    expect(chart.annotations["artifacthub.io/changes"]).toContain("kind: security");
  });

  test("keeps public deployment examples on the current release", async () => {
    const [compose, composeEnv, argo, flux, runbook] = await Promise.all([
      readFile("deploy/compose/docker-compose.yaml", "utf8"),
      readFile("deploy/compose/.env.example", "utf8"),
      readFile("deploy/k8s/examples/argocd-application.yaml", "utf8"),
      readFile("deploy/k8s/examples/flux-helmrelease.yaml", "utf8"),
      readFile("docs/client-integration-runbook.md", "utf8"),
    ]);

    expect(compose).toContain(`mcp-gw-agentgateway:${expectedVersion}`);
    expect(composeEnv).toContain(`mcp-gw-agentgateway:${expectedVersion}`);
    expect(argo).toContain(`targetRevision: ${expectedVersion}`);
    expect(flux).toContain(`tag: ${expectedVersion}`);
    expect(runbook).toContain(`--version ${expectedVersion}`);
  });
});
