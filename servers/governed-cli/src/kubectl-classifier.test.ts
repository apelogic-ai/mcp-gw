import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { CommandRefusedError } from "./classifier";
import { classifyKubectl } from "./kubectl-classifier";
import { loadCliPack, type CliPack } from "./pack";

let pack: CliPack;

beforeAll(async () => {
  pack = await loadCliPack(join(import.meta.dir, "../packs/kubectl/pack.yaml"));
});

describe("kubectl classifier", () => {
  test.each([
    [["get", "pods"], "get"],
    [["get", "pod/example", "-o", "wide"], "get"],
    [["--namespace=team", "get", "deployments"], "get"],
    [["get", "-A", "services", "--show-labels"], "get"],
    [["describe", "deployment/example"], "describe"],
    [["logs", "pod/example", "--tail=20", "--timestamps"], "logs"],
  ] as const)("classifies approved read argv %j", (args, command) => {
    expect(classifyKubectl(pack, args)).toEqual({ command, class: "read" });
  });

  test.each([
    ["get secret", "get:secret", ["get", "secret"]],
    ["get secrets", "get:secret", ["get", "secrets"]],
    ["get secret/name", "get:secret", ["get", "secret/name"]],
    ["get case-varied Secret", "get:secret", ["get", "Secret"]],
    ["get -A secrets", "get:secret", ["get", "-A", "secrets"]],
    ["describe secret", "describe:secret", ["describe", "secret"]],
    ["get secrets as json", "get:secret", ["get", "secrets", "-o", "json"]],
    ["get secrets as yaml", "get:secret", ["get", "secrets", "--output=yaml"]],
    ["get later secret", "get:secret", ["get", "pod/x", "secret/y"]],
    ["describe later secrets", "describe:secret", ["describe", "pod/x", "secrets/y"]],
    ["get later comma secrets", "get:secret", ["get", "pod/x", "service/y,secrets/z"]],
  ])("classifies %s as secret-read", (_name, command, args) => {
    expect(classifyKubectl(pack, args)).toEqual({ command, class: "secret-read" });
  });

  test.each(["wide", "name", "json", "yaml"])("allows the explicit %s output format", (format) => {
    expect(classifyKubectl(pack, ["get", "pods", `--output=${format}`])).toEqual({
      command: "get",
      class: "read",
    });
  });

  test.each([
    "--as",
    "--as-group",
    "--as-uid",
    "--token",
    "--server",
    "--kubeconfig",
    "--context",
    "--cluster",
    "--user",
    "--certificate-authority",
    "--insecure-skip-tls-verify",
  ])("refuses identity or target switch %s", (flag) => {
    expect(() => classifyKubectl(pack, ["get", "pods", `${flag}=attacker`])).toThrow(
      CommandRefusedError,
    );
  });

  test.each([
    ["unknown/plugin", ["plugin-name", "arg"]],
    ["alias", ["po", "example"]],
    ["write", ["apply", "-f", "change.yaml"]],
    ["destructive", ["delete", "pod/example"]],
    ["interactive exec", ["exec", "pod/example", "--", "sh"]],
    ["interactive port-forward", ["port-forward", "pod/example", "8080"]],
    ["file short flag", ["get", "pods", "-f", "/runner/credential"]],
    ["file long flag", ["get", "pods", "--filename=/runner/credential"]],
    ["raw API path", ["get", "--raw=/api/v1/secrets"]],
    ["unknown flag", ["get", "pods", "--watch"]],
    ["unsafe output", ["get", "pods", "-o", "jsonpath={.items}"]],
    ["argument separator", ["get", "pods", "--", "--as=attacker"]],
  ])("refuses %s", (_name, args) => {
    expect(() => classifyKubectl(pack, args)).toThrow(CommandRefusedError);
  });

  test("keeps shell metacharacters as ordinary resource-name arguments", () => {
    expect(classifyKubectl(pack, ["get", "pods", ";", "|", "$(touch /tmp/pwned)"])).toEqual({
      command: "get",
      class: "read",
    });
  });

  test("every classifier result is backed by the pack decision catalog", () => {
    for (const args of [
      ["get", "pods"],
      ["get", "secrets"],
      ["describe", "service/example"],
      ["describe", "secret/example"],
      ["logs", "pod/example"],
    ]) {
      const classified = classifyKubectl(pack, args);
      expect(pack.catalog.commands[classified.command]?.class).toBe(classified.class);
    }
  });
});
