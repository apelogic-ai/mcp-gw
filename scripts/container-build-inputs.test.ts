import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";

const digest = "sha256:[0-9a-f]{64}";

describe("wrapper container build inputs", () => {
  test("pins shared base images and apt packages", async () => {
    const dockerfiles = await Promise.all([
      readFile("servers/google-workspace/wrapper/Dockerfile", "utf8"),
      readFile("servers/github-mcp/wrapper/Dockerfile", "utf8"),
      readFile("servers/generic-wrapper/Dockerfile", "utf8"),
    ]);

    for (const dockerfile of dockerfiles) {
      expect(dockerfile).toMatch(new RegExp(`FROM alpine:3\\.22@${digest} AS ca-certificates`));
      expect(dockerfile).toMatch(new RegExp(`FROM oven/bun:1\\.2\\.21@${digest} AS bun`));
      expect(dockerfile).toMatch(new RegExp(`FROM ubuntu:24\\.04@${digest}`));
      expect(dockerfile).toMatch(/ARG UBUNTU_SNAPSHOT=\d{8}T\d{6}Z/);
      expect(dockerfile).toContain(
        "COPY --from=ca-certificates /etc/ssl/certs/ca-certificates.crt",
      );
      expect(dockerfile).toContain("http://archive.ubuntu.com/ubuntu/");
      expect(dockerfile).toContain("http://security.ubuntu.com/ubuntu/");
      expect(dockerfile).toContain("http://ports.ubuntu.com/ubuntu-ports/");
      expect(dockerfile).toContain("https://snapshot.ubuntu.com/ubuntu/$UBUNTU_SNAPSHOT/");
      expect(dockerfile).toContain("! grep -Eq 'https?://(archive|security|ports)\\.ubuntu\\.com'");
      expect(dockerfile).toContain("apt-get update --error-on=any");
      expect(dockerfile).toContain(
        'apt-cache policy ca-certificates | grep -F "https://snapshot.ubuntu.com/ubuntu/$UBUNTU_SNAPSHOT"',
      );
      expect(dockerfile).toMatch(/ca-certificates=[^\s\\]+/);
      expect(dockerfile).not.toMatch(/\bnodejs=/);
      expect(dockerfile).toContain("bun install --frozen-lockfile --production");
      expect(dockerfile).not.toContain("bun add");
    }
  });

  test("installs the Google Workspace CLI at build time from a checksummed release", async () => {
    const googleDockerfile = await readFile("servers/google-workspace/wrapper/Dockerfile", "utf8");

    expect(googleDockerfile).toContain("releases/download/v0.22.5");
    expect(googleDockerfile).toContain("google-workspace-cli-x86_64-unknown-linux-gnu.tar.gz");
    expect(googleDockerfile).toContain("google-workspace-cli-aarch64-unknown-linux-gnu.tar.gz");
    expect(googleDockerfile.match(/GWS_SHA256="[0-9a-f]{64}"/g)).toHaveLength(2);
    expect(googleDockerfile).toContain("sha256sum --check --strict");
    expect(googleDockerfile).toContain("GWS_BINARY_PATH=/usr/local/bin/gws");
  });

  test("keeps every shipped Google Workspace binary default aligned with the image", async () => {
    const paths = [
      "deploy/k8s/chart/values.yaml",
      "deploy/k8s/examples/values-k8s-broker-smoke.yaml",
      "deploy/compose/docker-compose.yaml",
      "deploy/compose/.env.example",
      "scripts/smoke-local-integration.sh",
      "scripts/smoke-external-issuer-integration.sh",
    ];
    const files = await Promise.all(paths.map((path) => readFile(path, "utf8")));

    for (const [index, contents] of files.entries()) {
      expect(contents, paths[index]).not.toContain("/app/node_modules/.bin/gws");
      expect(contents, paths[index]).toContain("/usr/local/bin/gws");
    }
  });

  test("executes the configured Google Workspace CLI in the Kubernetes release smoke", async () => {
    const smoke = await readFile("scripts/smoke-k8s-provider-runtime.sh", "utf8");

    expect(smoke).toContain("$GWS_BINARY_PATH");
    expect(smoke).toContain("gws 0.22.5");
    expect(smoke).toContain("GWS_VERSION_OUTPUT");
    expect(smoke).toContain("GWS_VERSION_OUTPUT%%");
    expect(smoke).toContain("Unexpected Google Workspace CLI version");
  });
});
