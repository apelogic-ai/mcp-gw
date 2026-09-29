import { appendFile, readFile } from "node:fs/promises";

export const GITHUB_MCP_SOURCE_PATH = ".release/github-mcp-source.json";

export type GitHubMcpSource = {
  sourceRepository: string;
  sourceTag: string;
  sourceDigest: string;
  mirrorRepository: string;
};

const registryRepositoryPattern = /^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+$/;
const tagPattern = /^v\d+\.\d+\.\d+$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const repositoryNamePattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

export async function resolveGitHubMcpSource(
  path = GITHUB_MCP_SOURCE_PATH,
): Promise<GitHubMcpSource> {
  const value = JSON.parse(await readFile(path, "utf8")) as Partial<GitHubMcpSource>;

  if (!value.sourceRepository || !registryRepositoryPattern.test(value.sourceRepository)) {
    throw new Error(`${path}: sourceRepository must be a registry repository without a tag`);
  }
  if (!value.sourceTag || !tagPattern.test(value.sourceTag)) {
    throw new Error(`${path}: sourceTag must be an immutable-looking vX.Y.Z release tag`);
  }
  if (!value.sourceDigest || !digestPattern.test(value.sourceDigest)) {
    throw new Error(`${path}: sourceDigest must be a lowercase sha256 digest`);
  }
  if (!value.mirrorRepository || !repositoryNamePattern.test(value.mirrorRepository)) {
    throw new Error(`${path}: mirrorRepository must be one unqualified OCI repository name`);
  }

  return {
    sourceRepository: value.sourceRepository,
    sourceTag: value.sourceTag,
    sourceDigest: value.sourceDigest,
    mirrorRepository: value.mirrorRepository,
  };
}

export function githubOutputs(source: GitHubMcpSource): Record<string, string> {
  return {
    mirror_repository: source.mirrorRepository,
    source_coordinate: `${source.sourceRepository}@${source.sourceDigest}`,
    source_digest: source.sourceDigest,
    source_repository: source.sourceRepository,
    source_tag: source.sourceTag,
  };
}

if (import.meta.main) {
  const outputFlag = process.argv.indexOf("--github-output");
  const outputPath = outputFlag === -1 ? undefined : process.argv[outputFlag + 1];
  const source = await resolveGitHubMcpSource();
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
    process.stdout.write(
      `${JSON.stringify({ ...source, sourceCoordinate: outputs.source_coordinate })}\n`,
    );
  }
}
