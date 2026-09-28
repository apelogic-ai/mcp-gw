import { appendFile, readFile } from "node:fs/promises";

export const AGENTGATEWAY_SOURCE_PATH = ".release/agentgateway-source.json";

export type AgentGatewaySource = {
  repository: string;
  ref: string;
  upstreamRepository: string;
};

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const commitPattern = /^[0-9a-f]{40}$/;

export async function resolveAgentGatewaySource(
  path = AGENTGATEWAY_SOURCE_PATH,
): Promise<AgentGatewaySource> {
  const value = JSON.parse(await readFile(path, "utf8")) as Partial<AgentGatewaySource>;

  if (!value.repository || !repositoryPattern.test(value.repository)) {
    throw new Error(`${path}: repository must be a GitHub owner/repository pair`);
  }
  if (!value.ref || !commitPattern.test(value.ref)) {
    throw new Error(`${path}: ref must be a full lowercase Git commit SHA`);
  }
  if (!value.upstreamRepository || !repositoryPattern.test(value.upstreamRepository)) {
    throw new Error(`${path}: upstreamRepository must be a GitHub owner/repository pair`);
  }
  if (value.upstreamRepository === value.repository) {
    throw new Error(`${path}: upstreamRepository must differ from the compatibility fork`);
  }

  return {
    repository: value.repository,
    ref: value.ref,
    upstreamRepository: value.upstreamRepository,
  };
}

export function githubOutputs(source: AgentGatewaySource): Record<string, string> {
  return {
    repository: source.repository,
    ref: source.ref,
    source_url: `https://github.com/${source.repository}`,
    upstream_repository: source.upstreamRepository,
  };
}

if (import.meta.main) {
  const outputFlag = process.argv.indexOf("--github-output");
  const outputPath = outputFlag === -1 ? undefined : process.argv[outputFlag + 1];
  const source = await resolveAgentGatewaySource();
  const outputs = githubOutputs(source);

  if (outputFlag !== -1 && !outputPath) {
    throw new Error("--github-output requires a path");
  }

  if (outputPath) {
    await appendFile(
      outputPath,
      Object.entries(outputs)
        .map(([name, value]) => `${name}=${value}\n`)
        .join(""),
    );
  } else {
    process.stdout.write(`${JSON.stringify({ ...source, sourceUrl: outputs.source_url })}\n`);
  }
}
