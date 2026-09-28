import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { githubOutputs, resolveAgentGatewaySource } from "./resolve-agentgateway-source";

describe("AgentGateway source pin", () => {
  test("resolves the repository, immutable ref, upstream, and source URL", async () => {
    const source = await resolveAgentGatewaySource();

    expect(source.repository).toBe("apelogic-ai/agentgateway");
    expect(source.ref).toMatch(/^[0-9a-f]{40}$/);
    expect(source.upstreamRepository).toBe("agentgateway/agentgateway");
    expect(githubOutputs(source)).toEqual({
      repository: source.repository,
      ref: source.ref,
      source_url: "https://github.com/apelogic-ai/agentgateway",
      upstream_repository: source.upstreamRepository,
    });
  });

  test("rejects mutable refs and malformed repository coordinates", async () => {
    for (const source of [
      {
        repository: "apelogic-ai/agentgateway",
        ref: "main",
        upstreamRepository: "agentgateway/agentgateway",
      },
      {
        repository: "https://github.com/apelogic-ai/agentgateway",
        ref: "a".repeat(40),
        upstreamRepository: "agentgateway/agentgateway",
      },
      {
        repository: "apelogic-ai/agentgateway",
        ref: "a".repeat(40),
        upstreamRepository: "apelogic-ai/agentgateway",
      },
    ]) {
      const directory = await mkdtemp(join(tmpdir(), "mcp-gw-agentgateway-source-"));
      const path = join(directory, "source.json");
      await writeFile(path, JSON.stringify(source));

      expect(resolveAgentGatewaySource(path)).rejects.toThrow();
    }
  });
});
