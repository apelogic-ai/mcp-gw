import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";

const digest = "sha256:[0-9a-f]{64}";

describe("wrapper container build inputs", () => {
  test("pins shared base images and apt packages", async () => {
    const dockerfiles = await Promise.all([
      readFile("servers/google-workspace/wrapper/Dockerfile", "utf8"),
      readFile("servers/github-mcp/wrapper/Dockerfile", "utf8"),
    ]);

    for (const dockerfile of dockerfiles) {
      expect(dockerfile).toMatch(new RegExp(`FROM oven/bun:1\\.2\\.21@${digest} AS bun`));
      expect(dockerfile).toMatch(new RegExp(`FROM ubuntu:24\\.04@${digest}`));
      expect(dockerfile).toMatch(/ca-certificates=[^\s\\]+/);
      expect(dockerfile).toMatch(/nodejs=[^\s\\]+/);
      expect(dockerfile).toContain("bun install --frozen-lockfile --production");
      expect(dockerfile).not.toContain("bun add");
    }
  });

  test("installs the Google Workspace CLI at build time from a checksummed release", async () => {
    const googleDockerfile = await readFile("servers/google-workspace/wrapper/Dockerfile", "utf8");

    expect(googleDockerfile).toContain("releases/download/v0.22.5");
    expect(googleDockerfile).toContain("google-workspace-cli-x86_64-unknown-linux-gnu.tar.gz");
    expect(googleDockerfile).toContain("google-workspace-cli-aarch64-unknown-linux-gnu.tar.gz");
    expect(googleDockerfile.match(/[0-9a-f]{64}/g)).toHaveLength(4);
    expect(googleDockerfile).toContain("sha256sum --check --strict");
    expect(googleDockerfile).toContain("GWS_BINARY_PATH=/usr/local/bin/gws");
  });
});
