import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadCliPack, parseCliPack, verifyCliPackBinary } from "./pack";

const packPath = join(import.meta.dir, "../packs/kubectl/pack.yaml");
const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(temporaryDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

describe("CLI pack", () => {
  test("derives read decisions from RBAC verbs and applies the Secret overlay", async () => {
    const pack = await loadCliPack(packPath);

    expect(pack.catalog.commands).toEqual({
      get: { class: "read" },
      "get:secret": { class: "secret-read" },
      describe: { class: "read" },
      "describe:secret": { class: "secret-read" },
      logs: { class: "read" },
    });
    expect(pack.operations.logs?.rbacResources).toEqual(["pods/log"]);
    expect(pack.credential).toEqual({
      provider: "kubernetes",
      sourceEnv: "GOVERNED_CLI_KUBECONFIG",
      targetEnv: "KUBECONFIG",
    });
    expect(pack.runner.env).not.toHaveProperty("KUBECONFIG");
  });

  test("refuses non-read RBAC verbs", async () => {
    const source = await Bun.file(packPath).text();
    expect(() =>
      parseCliPack(source.replace("rbacVerbs: [get, list]", "rbacVerbs: [create]")),
    ).toThrow("read RBAC verbs");
  });

  test("verifies the configured executable digest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "governed-cli-pack-"));
    temporaryDirectories.push(directory);
    const binary = join(directory, "kubectl");
    await writeFile(binary, "fake kubectl\n");
    await chmod(binary, 0o755);
    const sha256 = createHash("sha256").update("fake kubectl\n").digest("hex");
    const pack = await loadCliPack(packPath);
    const fixture = {
      ...pack,
      binary: { ...pack.binary, path: binary, sha256: { amd64: sha256, arm64: sha256 } },
    };

    expect(verifyCliPackBinary(fixture, "x64")).resolves.toBeUndefined();
    expect(
      verifyCliPackBinary(
        {
          ...fixture,
          binary: { ...fixture.binary, sha256: { amd64: "0".repeat(64), arm64: sha256 } },
        },
        "x64",
      ),
    ).rejects.toThrow("digest mismatch");
  });

  test("keeps image and pack pins in lockstep", async () => {
    const pack = await loadCliPack(packPath);
    const dockerfile = await Bun.file(join(import.meta.dir, "../Dockerfile")).text();

    expect(dockerfile).toContain(`ARG KUBECTL_VERSION=${pack.binary.version}`);
    expect(dockerfile).toContain(pack.binary.sha256.amd64);
    expect(dockerfile).toContain(pack.binary.sha256.arm64);
    expect(dockerfile).toContain("sha256sum -c");
  });
});
