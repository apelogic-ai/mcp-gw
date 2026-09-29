import { readFile } from "node:fs/promises";
import { resolveAgentGatewaySource } from "./resolve-agentgateway-source";
import { resolveGitHubMcpSource } from "./resolve-github-mcp-source";

interface PackageJson {
  version?: unknown;
}

const semverPattern = /^\d+\.\d+\.\d+$/;

async function main(): Promise<void> {
  const [
    packageJsonRaw,
    changelog,
    releaseDocs,
    releaseWorkflow,
    ciWorkflow,
    agentGateway,
    githubMcp,
  ] = await Promise.all([
    readFile("package.json", "utf8"),
    readFile("CHANGELOG.md", "utf8"),
    readFile("docs/releases.md", "utf8"),
    readFile(".github/workflows/release.yml", "utf8"),
    readFile(".github/workflows/ci.yml", "utf8"),
    resolveAgentGatewaySource(),
    resolveGitHubMcpSource(),
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
  expectText(
    releaseWorkflow,
    "runner: ubuntu-24.04-arm",
    "release workflow must build ARM64 images on native ARM64 runners",
  );
  expectText(
    releaseWorkflow,
    "docker buildx imagetools create",
    "release workflow must assemble both supported image platforms into one manifest",
  );
  expectText(
    ciWorkflow,
    "docker/build-push-action@",
    "CI must build the pinned AgentGateway candidate tested by integration smoke",
  );
  for (const [name, workflow] of [
    ["CI", ciWorkflow],
    ["release", releaseWorkflow],
  ] as const) {
    expectText(
      workflow,
      "bun scripts/resolve-agentgateway-source.ts",
      `${name} workflow must resolve the shared AgentGateway source pin`,
    );
    expectNotText(
      workflow,
      agentGateway.ref,
      `${name} workflow must not duplicate the AgentGateway commit pin`,
    );
  }
  expectNotText(
    ciWorkflow,
    "ghcr.io/apelogic-ai/mcp-gw-agentgateway@sha256:",
    "CI must build the pinned AgentGateway source instead of testing an older published digest",
  );
  expectText(
    releaseWorkflow,
    "bun scripts/resolve-github-mcp-source.ts",
    "release workflow must resolve the shared GitHub MCP Server source pin",
  );
  expectNotText(
    releaseWorkflow,
    githubMcp.sourceDigest,
    "release workflow must not duplicate the GitHub MCP Server digest pin",
  );
}

function expectText(content: string, needle: string, message: string): void {
  if (!content.includes(needle)) {
    throw new Error(message);
  }
}

function expectNotText(content: string, needle: string, message: string): void {
  if (content.includes(needle)) {
    throw new Error(message);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
