import { describe, expect, test } from "bun:test";
import type { Hop1Identity } from "../../../shared/identity/hop1";
import { taskAuthority, withTaskAuthority } from "../../../test/support/task-authority-fixture";
import { CLI_DECISIONS_SCHEMA, parseCliDecisionCatalog } from "./catalog";
import { CommandRefusedError } from "./classifier";
import { createCliRunHandler, type CliTarget } from "./http";

const catalog = parseCliDecisionCatalog(`
schemaVersion: ${CLI_DECISIONS_SCHEMA}
cli: fixture
commands:
  inspect:
    class: read
  reveal:
    class: secret-read
`);

const target: CliTarget = {
  catalog,
  runner: {
    binary: "/opt/fixture",
    env: { PATH: "/fixed/bin" },
    cwd: "/runner",
    defaultTimeoutSeconds: 30,
    maxTimeoutSeconds: 60,
    maxOutputBytes: 1024,
  },
  classifier: {
    classify(args) {
      const command = args[0];
      const decision = command ? catalog.commands[command] : undefined;
      if (!command || !decision) throw new CommandRefusedError("fixture command is not approved");
      return { command, class: decision.class };
    },
  },
};

const requestLimits = {
  maxBodyBytes: 64 * 1024,
  maxArgs: 64,
  maxArgBytes: 4 * 1024,
};

function identity(actions: string[], restricted = true): Hop1Identity {
  return {
    profile: "test",
    issuer: "https://identity.example.com",
    subject: "subject",
    email: "person@example.com",
    claims: restricted
      ? withTaskAuthority({
          ...taskAuthority,
          tools: actions.map((action) => ({ provider: "cli", resource: "fixture", action })),
        })
      : {},
  };
}

function request(body: unknown, query = ""): Request {
  return new Request(`http://localhost/cli/run${query}`, {
    method: "POST",
    headers: { authorization: "Bearer run-token", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("governed CLI HTTP", () => {
  test("requires a valid restricted Task token and exact class grant before credentials or spawn", async () => {
    let credentials = 0;
    let executions = 0;
    const handler = createCliRunHandler({
      authenticate: () => Promise.resolve(identity(["read"])),
      requestLimits,
      targets: [
        {
          ...target,
          credentialEnv: () => {
            credentials += 1;
            return Promise.resolve({ RUNNER_TOKEN: "provider-secret" });
          },
        },
      ],
      execute: () => {
        executions += 1;
        throw new Error("must not execute");
      },
    });

    expect(
      await handler(new Request("http://localhost/cli/run", { method: "POST" })),
    ).toMatchObject({ status: 401 });
    expect(await handler(request({ cli: "fixture", args: ["reveal"] }))).toMatchObject({
      status: 403,
    });
    expect(await handler(request({ cli: "other", args: ["inspect"] }))).toMatchObject({
      status: 403,
    });

    const interactive = createCliRunHandler({
      authenticate: () => Promise.resolve(identity([], false)),
      requestLimits,
      targets: [target],
      execute: () => {
        executions += 1;
        throw new Error("must not execute");
      },
    });
    expect(await interactive(request({ cli: "fixture", args: ["inspect"] }))).toMatchObject({
      status: 403,
    });
    expect([credentials, executions]).toEqual([0, 0]);
  });

  test("refuses unknown commands and request-controlled process settings", async () => {
    let executions = 0;
    const handler = createCliRunHandler({
      authenticate: () => Promise.resolve(identity(["read"])),
      requestLimits,
      targets: [target],
      execute: () => {
        executions += 1;
        throw new Error("must not execute");
      },
    });

    expect(await handler(request({ cli: "fixture", args: ["unknown"] }))).toMatchObject({
      status: 400,
    });
    for (const extra of [
      { env: { RUNNER_TOKEN: "attacker" } },
      { cwd: "/attacker" },
      { stdin: "data" },
    ]) {
      expect(await handler(request({ cli: "fixture", args: ["inspect"], ...extra }))).toMatchObject(
        { status: 400 },
      );
    }
    expect(executions).toBe(0);
  });

  test("refuses oversized bodies and argument vectors before classification", async () => {
    let classifications = 0;
    const handler = createCliRunHandler({
      authenticate: () => Promise.resolve(identity(["read"])),
      requestLimits: { maxBodyBytes: 64, maxArgs: 2, maxArgBytes: 8 },
      targets: [
        {
          ...target,
          classifier: {
            classify(args) {
              classifications += 1;
              return target.classifier.classify(args);
            },
          },
        },
      ],
    });

    const declaredOversize = request({ cli: "fixture", args: ["inspect"] });
    declaredOversize.headers.set("content-length", "65");
    expect(await handler(declaredOversize)).toMatchObject({ status: 413 });
    expect(
      await handler(request({ cli: "fixture", args: ["inspect", "x".repeat(65)] })),
    ).toMatchObject({ status: 413 });
    expect(await handler(request({ cli: "fixture", args: ["inspect", "x", "y"] }))).toMatchObject({
      status: 400,
    });
    expect(
      await handler(request({ cli: "fixture", args: ["inspect", "123456789"] })),
    ).toMatchObject({ status: 400 });
    expect(classifications).toBe(0);
  });

  test("streams NDJSON output and a single final exit event", async () => {
    const calls: unknown[] = [];
    const handler = createCliRunHandler({
      authenticate: () => Promise.resolve(identity(["read"])),
      requestLimits,
      targets: [
        {
          ...target,
          credentialEnv: () => Promise.resolve({ RUNNER_TOKEN: "provider-secret" }),
        },
      ],
      execute: (config, args, commandClass, timeout, options) => {
        if (!options) throw new Error("missing execution options");
        calls.push({ config, args, commandClass, timeout, credentialEnv: options.credentialEnv });
        options.onOutput?.("stdout", "first\n");
        options.onOutput?.("stderr", "warning\n");
        options.onOutput?.("stdout", "last\n");
        return Promise.resolve({
          exit_code: 7,
          stdout: "first\nlast\n",
          stderr: "warning\n",
          stdout_truncated: true,
          stderr_truncated: false,
          duration_ms: 1,
          class: commandClass,
        });
      },
    });

    const response = await handler(
      request({ cli: "fixture", args: ["inspect", ";", "|", "$(x)"] }),
    );
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    expect(
      (await response.text())
        .trim()
        .split("\n")
        .map((line): unknown => JSON.parse(line) as unknown),
    ).toEqual([
      { type: "stdout", data: "first\n" },
      { type: "stderr", data: "warning\n" },
      { type: "stdout", data: "last\n" },
      { type: "exit", exit_code: 7, truncated: true },
    ]);
    expect(calls).toEqual([
      {
        config: target.runner,
        args: ["inspect", ";", "|", "$(x)"],
        commandClass: "read",
        timeout: undefined,
        credentialEnv: { RUNNER_TOKEN: "provider-secret" },
      },
    ]);
    expect(JSON.stringify(calls)).not.toContain("run-token");
  });

  test("returns one combined response for wait=full", async () => {
    const handler = createCliRunHandler({
      authenticate: () => Promise.resolve(identity(["read"])),
      requestLimits,
      targets: [target],
      execute: (_config, _args, commandClass, _timeout, options) => {
        if (!options) throw new Error("missing execution options");
        expect(options.onOutput).toBeUndefined();
        return Promise.resolve({
          exit_code: 0,
          stdout: "complete",
          stderr: "",
          stdout_truncated: false,
          stderr_truncated: false,
          duration_ms: 1,
          class: commandClass,
        });
      },
    });

    expect(
      await (await handler(request({ cli: "fixture", args: ["inspect"] }, "?wait=full"))).json(),
    ).toEqual({ exit_code: 0, stdout: "complete", stderr: "" });
  });
});
