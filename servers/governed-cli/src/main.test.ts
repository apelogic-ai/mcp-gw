import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { Hop1Identity } from "../../../shared/identity/hop1";
import { createKubectlTarget } from "./main";
import { loadCliPack } from "./pack";

const identity = {} as Hop1Identity;

describe("governed CLI runtime", () => {
  test("injects only the pack-bound credential after authorization", async () => {
    const pack = await loadCliPack(join(import.meta.dir, "../packs/kubectl/pack.yaml"));
    const target = createKubectlTarget(pack, {
      GOVERNED_CLI_KUBECONFIG: "/var/run/credentials/kubeconfig",
      HOP1_TOKEN: "must-not-reach-child",
    });

    expect(await target.credentialEnv?.(identity)).toEqual({
      KUBECONFIG: "/var/run/credentials/kubeconfig",
    });
    expect(target.runner.env).toEqual({ HOME: "/tmp", PATH: "/usr/local/bin:/usr/bin:/bin" });
    expect(JSON.stringify(target)).not.toContain("must-not-reach-child");
  });

  test("fails closed when the configured credential is absent", async () => {
    const pack = await loadCliPack(join(import.meta.dir, "../packs/kubectl/pack.yaml"));
    const target = createKubectlTarget(pack, {});

    expect(target.credentialEnv?.(identity)).rejects.toThrow("GOVERNED_CLI_KUBECONFIG");
  });

  test("refuses a pack bound to a different credential provider", async () => {
    const pack = await loadCliPack(join(import.meta.dir, "../packs/kubectl/pack.yaml"));
    expect(() =>
      createKubectlTarget({ ...pack, credential: { ...pack.credential, provider: "other" } }, {}),
    ).toThrow("must be kubernetes");
  });
});
