import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface PrivateReleaseHandoffOptions {
  artifactsDirectory: string;
  chartRepository: string;
  imageRepository: string;
  outputPath: string;
  releaseCommit: string;
  version: string;
}

const digestPattern = /^sha256:[a-f0-9]{64}$/;

export async function generatePrivateReleaseHandoff(
  options: PrivateReleaseHandoffOptions,
): Promise<void> {
  const imageDigest = await readDigest(options.artifactsDirectory, "ecr-agentgateway");
  const chartDigest = await readDigest(options.artifactsDirectory, "ecr-helm-chart");
  const image = `${options.imageRepository}@${imageDigest}`;
  const chart = `${options.chartRepository}@${chartDigest}`;

  const handoff = `# MCP Gateway v${options.version} Private Registry Handoff

- Release commit: \`${options.releaseCommit}\`
- Agentgateway image: \`${image}\`
- Helm chart artifact: \`${chart}\`
- Helm chart version: \`${options.version}\`

## Evidence

| Artifact | Evidence files |
| --- | --- |
| Agentgateway image | \`agentgateway.spdx.json\`, \`agentgateway.vulnerabilities.json\`, \`ecr-agentgateway.sig\`, \`ecr-agentgateway.pem\`, \`ecr-agentgateway.provenance.json\` |
| Helm chart | \`helm-chart.spdx.json\`, \`helm-chart.vulnerabilities.json\`, \`ecr-helm-chart.sig\`, \`ecr-helm-chart.pem\`, \`ecr-helm-chart.provenance.json\` |

The ECR digest files are \`ecr-agentgateway.digest\` and \`ecr-helm-chart.digest\`. They match the
approved public release manifests byte-for-byte.

## Verification

Authenticate to the private registry, then verify the keyless signatures against the release
workflow identity:

\`\`\`bash
IDENTITY="https://github.com/$GITHUB_REPOSITORY/.github/workflows/release.yml@refs/tags/v${options.version}"
cosign verify \\
  --certificate-identity "$IDENTITY" \\
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \\
  "${image}"
cosign verify \\
  --certificate-identity "$IDENTITY" \\
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \\
  "${chart}"
\`\`\`

Configure GitOps with the chart version and chart digest above. Configure
\`agentgateway.image.repository\` to \`${options.imageRepository}\` and
\`agentgateway.image.digest\` to \`${imageDigest}\`. The chart renders the runtime image by digest.
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
        "Expected --version, --release-commit, --image-repository, --chart-repository, --artifacts, and --output arguments",
      );
    }
    values.set(key, value);
  }

  const version = values.get("--version");
  const releaseCommit = values.get("--release-commit");
  const imageRepository = values.get("--image-repository");
  const chartRepository = values.get("--chart-repository");
  const artifactsDirectory = values.get("--artifacts");
  const outputPath = values.get("--output");
  if (
    !version ||
    !releaseCommit ||
    !imageRepository ||
    !chartRepository ||
    !artifactsDirectory ||
    !outputPath
  ) {
    throw new Error(
      "Expected --version, --release-commit, --image-repository, --chart-repository, --artifacts, and --output arguments",
    );
  }

  return {
    artifactsDirectory,
    chartRepository,
    imageRepository,
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
