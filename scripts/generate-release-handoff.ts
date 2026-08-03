import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ReleaseHandoffOptions {
  artifactsDirectory: string;
  outputPath: string;
  owner: string;
  version: string;
}

const digestPattern = /^sha256:[a-f0-9]{64}$/;

export async function generateReleaseHandoff(options: ReleaseHandoffOptions): Promise<void> {
  const digests = {
    agentgateway: await readDigest(options.artifactsDirectory, "agentgateway"),
    googleWorkspace: await readDigest(options.artifactsDirectory, "google-workspace"),
    githubWrapper: await readDigest(options.artifactsDirectory, "github-wrapper"),
    chart: await readDigest(options.artifactsDirectory, "helm-chart"),
  };
  const registry = `ghcr.io/${options.owner}`;
  const chart = `oci://${registry}/charts/mcp-gateway`;

  const handoff = `# MCP Gateway v${options.version} Release Handoff

## OCI Chart

- Coordinate: \`${chart}\`
- Version: \`${options.version}\`
- Digest: \`${digests.chart}\`

\`\`\`bash
helm upgrade --install mcp-gateway ${chart} \\
  --version ${options.version} \\
  --values private-values.yaml
\`\`\`

## First-Party Images

| Component | Immutable image |
| --- | --- |
| agentgateway | \`${registry}/mcp-gw-agentgateway@${digests.agentgateway}\` |
| Google Workspace wrapper | \`${registry}/mcp-gw-google-workspace@${digests.googleWorkspace}\` |
| GitHub wrapper | \`${registry}/mcp-gw-github-wrapper@${digests.githubWrapper}\` |

The chart also references the separately maintained official GitHub MCP Server image. Pin or mirror
that image by digest in the private values overlay.

## Runtime Contract

- agentgateway: TCP \`8080\`, public MCP path \`/mcp\`.
- Google Workspace wrapper: TCP \`8080\`, internal MCP path \`/mcp\`.
- GitHub wrapper: TCP \`8080\`, internal MCP path \`/mcp\`.
- Official GitHub MCP Server: TCP \`8082\`, internal MCP path \`/mcp\`.
- Default Kubernetes Services are \`ClusterIP\`; ingress is opt-in.
- Every workload has configurable liveness and readiness probes under its \`probes\` values.

## Existing Secret Keys

The chart creates no provider credentials. When the corresponding adapter is enabled, reference an
existing Kubernetes Secret containing these environment-variable keys:

- Google Workspace: \`TOKEN_STORE_DSN\`, \`GOOGLE_OAUTH_CLIENT_ID\`,
  \`GOOGLE_OAUTH_CLIENT_SECRET\`, \`GOOGLE_OAUTH_REDIRECT_URI\`,
  \`GOOGLE_TOKEN_ENCRYPTION_KEY\`.
- GitHub: \`TOKEN_STORE_DSN\`, \`GITHUB_OAUTH_CLIENT_ID\`,
  \`GITHUB_OAUTH_CLIENT_SECRET\`, \`GITHUB_OAUTH_REDIRECT_URI\`,
  \`GITHUB_TOKEN_ENCRYPTION_KEY\`.
- Issuer introspection credentials: any key selected by each
  \`hop1.issuers[].introspection.credentialSecretKeyRef\`.

## Supply-Chain Evidence

This GitHub Release includes an SPDX JSON SBOM, a JSON vulnerability report, and a digest file for
each first-party image. GitHub build-provenance attestations are attached to each image digest and to
the OCI chart digest.
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

function parseArgs(args: string[]): ReleaseHandoffOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error("Expected --version, --owner, --artifacts, and --output arguments");
    }
    values.set(key, value);
  }

  const version = values.get("--version");
  const owner = values.get("--owner");
  const artifactsDirectory = values.get("--artifacts");
  const outputPath = values.get("--output");
  if (!version || !owner || !artifactsDirectory || !outputPath) {
    throw new Error("Expected --version, --owner, --artifacts, and --output arguments");
  }
  return { artifactsDirectory, outputPath, owner, version };
}

if (import.meta.main) {
  generateReleaseHandoff(parseArgs(process.argv.slice(2))).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
