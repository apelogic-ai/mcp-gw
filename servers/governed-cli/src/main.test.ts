import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { Hop1Identity } from "../../../shared/identity/hop1";
import { taskAuthority, withTaskAuthority } from "../../../test/support/task-authority-fixture";
import { createCliRunHandler } from "./http";
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

  test.each([
    ["get", "pod/x", "secret/y"],
    ["describe", "pod/x", "secrets/y"],
    ["get", "pod/x", "service/y,secrets/z"],
  ])("refuses a later Secret resource under a read-only grant: %j", async (...args) => {
    const pack = await loadCliPack(join(import.meta.dir, "../packs/kubectl/pack.yaml"));
    let executions = 0;
    const handler = createCliRunHandler({
      authenticate: () =>
        Promise.resolve({
          ...identity,
          claims: withTaskAuthority({
            ...taskAuthority,
            tools: [{ provider: "cli", resource: "kubectl", action: "read" }],
          }),
        }),
      targets: [createKubectlTarget(pack, { GOVERNED_CLI_KUBECONFIG: "/credentials/kubeconfig" })],
      requestLimits: pack.requestLimits,
      jobLimits: pack.jobLimits,
      execute: () => {
        executions += 1;
        throw new Error("must not execute");
      },
    });
    const response = await handler(
      new Request("http://localhost/cli/run", {
        method: "POST",
        headers: { authorization: "Bearer run-token", "content-type": "application/json" },
        body: JSON.stringify({ cli: "kubectl", args }),
      }),
    );

    expect(response.status).toBe(403);
    expect(executions).toBe(0);
  });
});
