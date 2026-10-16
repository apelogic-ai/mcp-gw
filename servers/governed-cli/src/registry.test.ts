import { describe, expect, test } from "bun:test";
import type { Hop1Identity } from "../../../shared/identity/hop1";
import { CLI_DECISIONS_SCHEMA, type CliDecisionCatalog } from "./catalog";
import { CommandRefusedError } from "./classifier";
import { createCliRegistry, type CliTarget } from "./registry";
import { createGovernedCliHandler } from "./server";

const catalog: CliDecisionCatalog = {
  schemaVersion: CLI_DECISIONS_SCHEMA,
  cli: "fixture",
  commands: {
    inspect: { class: "read" },
    reveal: { class: "secret-read" },
    change: { class: "write" },
    erase: { class: "destructive" },
  },
};
const runner = {
  binary: "unused",
  env: { PATH: "/fixed/bin", RUNNER_TOKEN: "runner-owned" },
  cwd: "/runner",
  redactValues: ["runner-owned"],
  defaultTimeoutSeconds: 30,
  maxTimeoutSeconds: 120,
  maxOutputBytes: 1024,
};
const target: CliTarget = {
  catalog,
  runner,
  classifier: {
    classify(args) {
      const command = args[0];
      const decision = command ? catalog.commands[command] : undefined;
      if (!command || !decision) throw new CommandRefusedError("fixture command is not approved");
      return { command, class: decision.class };
    },
  },
};

function identity(actions: string[]): Hop1Identity {
  return {
    profile: "test",
    issuer: "https://identity.example.com",
    subject: "subject",
    email: "person@example.com",
    claims: {
      [["ste", "ward"].join("")]: {
        version: 3,
        runtime_uid: "run-1",
        acting_as: "user",
        tools: actions.map((action) => ({ provider: "cli", resource: "fixture", action })),
      },
    },
  };
}

describe("governed CLI registry", () => {
  test("a Task without a CLI class cannot list or call the tools", async () => {
    const handler = createGovernedCliHandler({
      authenticate: () => Promise.resolve(identity([])),
      targets: [target],
    });
    const request = (method: string, params?: unknown) =>
      handler(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: { authorization: "Bearer test" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        }),
      );

    expect(await (await request("tools/list")).json()).toMatchObject({ result: { tools: [] } });
    expect(
      await (
        await request("tools/call", {
          name: "cli_run",
          arguments: { cli: "fixture", args: ["inspect"] },
        })
      ).json(),
    ).toMatchObject({
      result: { isError: true, structuredContent: { error: "task_tool_not_approved" } },
    });
  });

  test("lists only granted classes and runs an approved classified command", async () => {
    const calls: { config: unknown; args: readonly string[]; commandClass: string }[] = [];
    const registry = createCliRegistry({
      identity: identity(["read"]),
      targets: [target],
      execute: (config, args, commandClass) => {
        calls.push({ config, args, commandClass });
        return Promise.resolve({
          exit_code: 0,
          stdout: "ok",
          stderr: "",
          stdout_truncated: false,
          stderr_truncated: false,
          duration_ms: 1,
          class: commandClass,
        });
      },
    });
    expect((await registry.callTool("cli_list", {})).structuredContent).toEqual({
      clis: [{ cli: "fixture", classes: ["read"] }],
    });
    expect(
      (
        await registry.callTool("cli_run", {
          cli: "fixture",
          args: ["inspect"],
          env: { RUNNER_TOKEN: "attacker" },
          cwd: "/attacker",
        })
      ).isError,
    ).toBeUndefined();
    expect(calls).toEqual([{ config: runner, args: ["inspect"], commandClass: "read" }]);
  });

  test("refuses an unapproved target or command class before execution", async () => {
    let executions = 0;
    const registry = createCliRegistry({
      identity: identity(["read"]),
      targets: [target],
      execute: () => {
        executions += 1;
        throw new Error("must not execute");
      },
    });
    expect(await registry.callTool("cli_run", { cli: "other", args: ["inspect"] })).toMatchObject({
      isError: true,
      structuredContent: { error: "cli_command_refused" },
    });
    expect(await registry.callTool("cli_run", { cli: "fixture", args: ["change"] })).toMatchObject({
      isError: true,
      structuredContent: { error: "task_tool_not_approved" },
    });
    expect(await registry.callTool("cli_run", { cli: "fixture", args: ["reveal"] })).toMatchObject({
      isError: true,
      structuredContent: { error: "task_tool_not_approved" },
    });
    expect(executions).toBe(0);
  });

  test("requires an exact secret-read grant for sensitive commands", async () => {
    const registry = createCliRegistry({
      identity: identity(["secret-read"]),
      targets: [target],
      execute: (_config, _args, commandClass) =>
        Promise.resolve({
          exit_code: 0,
          stdout: "sensitive",
          stderr: "",
          stdout_truncated: false,
          stderr_truncated: false,
          duration_ms: 1,
          class: commandClass,
        }),
    });

    expect((await registry.callTool("cli_list", {})).structuredContent).toEqual({
      clis: [{ cli: "fixture", classes: ["secret-read"] }],
    });
    expect(
      (await registry.callTool("cli_run", { cli: "fixture", args: ["reveal"] })).structuredContent,
    ).toMatchObject({ class: "secret-read" });
  });

  test("refuses a classifier result absent from its catalog", async () => {
    const inconsistent = {
      ...target,
      classifier: { classify: () => ({ command: "missing", class: "read" as const }) },
    };
    const registry = createCliRegistry({ identity: identity(["read"]), targets: [inconsistent] });
    expect(await registry.callTool("cli_run", { cli: "fixture", args: ["missing"] })).toMatchObject(
      {
        isError: true,
        structuredContent: { error: "cli_command_refused" },
      },
    );
  });
});
