import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { githubOutputs, resolveGitHubMcpSource } from "./resolve-github-mcp-source";

describe("GitHub MCP Server source pin", () => {
  test("resolves one immutable upstream image and release mirror name", async () => {
    const source = await resolveGitHubMcpSource();

    expect(source.sourceRepository).toBe("ghcr.io/github/github-mcp-server");
    expect(source.sourceTag).toBe("v1.6.0");
    expect(source.sourceDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(source.mirrorRepository).toBe("mcp-gw-github-mcp-server");
    expect(githubOutputs(source)).toEqual({
      mirror_repository: source.mirrorRepository,
      source_coordinate: `${source.sourceRepository}@${source.sourceDigest}`,
      source_digest: source.sourceDigest,
      source_repository: source.sourceRepository,
      source_tag: source.sourceTag,
    });
  });

  test("rejects mutable or malformed source records", async () => {
    const valid = {
      sourceRepository: "ghcr.io/github/github-mcp-server",
      sourceTag: "v1.6.0",
      sourceDigest: `sha256:${"a".repeat(64)}`,
      mirrorRepository: "mcp-gw-github-mcp-server",
    };

    for (const source of [
      { ...valid, sourceDigest: "latest" },
      { ...valid, sourceTag: "latest" },
      { ...valid, sourceRepository: "https://ghcr.io/github/github-mcp-server" },
      { ...valid, mirrorRepository: "owner/repository" },
    ]) {
      const directory = await mkdtemp(join(tmpdir(), "mcp-gw-github-mcp-source-"));
      const path = join(directory, "source.json");
      await writeFile(path, JSON.stringify(source));

      expect(resolveGitHubMcpSource(path)).rejects.toThrow();
    }
  });
});
