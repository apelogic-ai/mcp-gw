import { readFile } from "node:fs/promises";

interface PackageJson {
  version?: unknown;
}

const semverPattern = /^\d+\.\d+\.\d+$/;

async function main(): Promise<void> {
  const [packageJsonRaw, changelog, releaseDocs, releaseWorkflow] = await Promise.all([
    readFile("package.json", "utf8"),
    readFile("CHANGELOG.md", "utf8"),
    readFile("docs/releases.md", "utf8"),
    readFile(".github/workflows/release.yml", "utf8"),
  ]);

  const packageJson = JSON.parse(packageJsonRaw) as PackageJson;
  if (typeof packageJson.version !== "string" || !semverPattern.test(packageJson.version)) {
    throw new Error("package.json version must be SemVer without a leading v");
  }

  const version = packageJson.version;
  const tag = `v${version}`;

  expectText(changelog, "## [Unreleased]", "CHANGELOG.md must keep an Unreleased section");
  expectText(changelog, `## [${version}]`, `CHANGELOG.md must document ${version}`);
  expectText(releaseDocs, tag, `docs/releases.md must include the current release tag ${tag}`);
  expectText(releaseWorkflow, "v*.*.*", "release workflow must run for version tags");
  expectText(releaseWorkflow, "gh release create", "release workflow must create GitHub Releases");
}

function expectText(content: string, needle: string, message: string): void {
  if (!content.includes(needle)) {
    throw new Error(message);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
