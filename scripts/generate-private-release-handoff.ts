import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface PrivateReleaseHandoffOptions {
  agentgatewayRepository: string;
  artifactsDirectory: string;
  chartRepository: string;
  githubWrapperRepository: string;
  googleWorkspaceRepository: string;
  outputPath: string;
  releaseCommit: string;
  version: string;
}

const digestPattern = /^sha256:[a-f0-9]{64}$/;

export async function generatePrivateReleaseHandoff(
  options: PrivateReleaseHandoffOptions,
): Promise<void> {
  const agentgatewayDigest = await readDigest(options.artifactsDirectory, "ecr-agentgateway");
  const googleWorkspaceDigest = await readDigest(
    options.artifactsDirectory,
    "ecr-google-workspace",
  );
  const githubWrapperDigest = await readDigest(options.artifactsDirectory, "ecr-github-wrapper");
  const chartDigest = await readDigest(options.artifactsDirectory, "ecr-helm-chart");
  const agentgateway = `${options.agentgatewayRepository}@${agentgatewayDigest}`;
  const googleWorkspace = `${options.googleWorkspaceRepository}@${googleWorkspaceDigest}`;
  const githubWrapper = `${options.githubWrapperRepository}@${githubWrapperDigest}`;
  const chart = `${options.chartRepository}@${chartDigest}`;

  const handoff = `# MCP Gateway v${options.version} Private Registry Handoff

- Release commit: \`${options.releaseCommit}\`
- Agentgateway image: \`${agentgateway}\`
- Google Workspace wrapper image: \`${googleWorkspace}\`
- GitHub wrapper image: \`${githubWrapper}\`
- Helm chart artifact: \`${chart}\`
- Helm chart version: \`${options.version}\`

## Evidence

| Artifact | Evidence files |
| --- | --- |
| Agentgateway image | \`agentgateway.spdx.json\`, \`agentgateway.vulnerabilities.json\` |
| Google Workspace wrapper image | \`google-workspace.spdx.json\`, \`google-workspace.vulnerabilities.json\` |
| GitHub wrapper image | \`github-wrapper.spdx.json\`, \`github-wrapper.vulnerabilities.json\` |
| Helm chart | \`helm-chart.spdx.json\`, \`helm-chart.vulnerabilities.json\` |

The ECR digest files are \`ecr-agentgateway.digest\`, \`ecr-google-workspace.digest\`,
\`ecr-github-wrapper.digest\`, and \`ecr-helm-chart.digest\`. They match the approved public release
manifests byte-for-byte. The public GHCR source artifacts carry the release provenance; private
copies are not separately attested or signed, so private registry coordinates are never written to
a public transparency log.

## Verification

Authenticate to the private registry and confirm each descriptor digest matches the corresponding
public release digest. Verify provenance against the public GHCR source coordinate:

\`\`\`bash
gh attestation verify \\
  "oci://ghcr.io/<owner>/mcp-gw-agentgateway@${agentgatewayDigest}" \\
  --repo <owner>/mcp-gw \\
  --cert-identity "https://github.com/<owner>/mcp-gw/.github/workflows/release.yml@refs/tags/v${options.version}"
\`\`\`

Configure GitOps with the chart version and chart digest above. Configure
\`agentgateway.image.repository\` to \`${options.agentgatewayRepository}\` and
\`agentgateway.image.digest\` to \`${agentgatewayDigest}\`. Configure the equivalent repository and
digest fields for \`googleWorkspace.image\` and \`githubWrapper.image\` using the coordinates above.
The chart renders each first-party runtime image by digest.
`;

  await writeFile(options.outputPath, handoff);
}

async function readDigest(directory: string, component: string): Promise<string> {
  const digest = (await readFile(join(directory, `${component}.digest`), "utf8")).trim();
  if (!digestPattern.test(digest)) {
    throw new Error(`Invalid ${component} digest: ${digest}`);
  }
  return digest;
}

function parseArgs(args: string[]): PrivateReleaseHandoffOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error(
        "Expected repository coordinates, --version, --release-commit, --artifacts, and --output arguments",
      );
    }
    values.set(key, value);
  }

  const version = values.get("--version");
  const releaseCommit = values.get("--release-commit");
  const agentgatewayRepository = values.get("--agentgateway-repository");
  const googleWorkspaceRepository = values.get("--google-workspace-repository");
  const githubWrapperRepository = values.get("--github-wrapper-repository");
  const chartRepository = values.get("--chart-repository");
  const artifactsDirectory = values.get("--artifacts");
  const outputPath = values.get("--output");
  if (
    !version ||
    !releaseCommit ||
    !agentgatewayRepository ||
    !googleWorkspaceRepository ||
    !githubWrapperRepository ||
    !chartRepository ||
    !artifactsDirectory ||
    !outputPath
  ) {
    throw new Error(
      "Expected repository coordinates, --version, --release-commit, --artifacts, and --output arguments",
    );
  }

  return {
    agentgatewayRepository,
    artifactsDirectory,
    chartRepository,
    githubWrapperRepository,
    googleWorkspaceRepository,
    outputPath,
    releaseCommit,
    version,
  };
}

if (import.meta.main) {
  generatePrivateReleaseHandoff(parseArgs(process.argv.slice(2))).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
