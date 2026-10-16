import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createAwsCliRunner,
  createSsmRunCommand,
  SSM_DOCUMENT_NAME,
  SsmRunCommandError,
  type AwsCliRunner,
} from "./ssm-run-command";

const tempDirs: string[] = [];
const instanceId = "i-0123456789abcdef0";
const runtimeUid = "runtime-a";
const runTagKey = "hypershell:run-id";

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("Systems Manager Run Command transport", () => {
  test("passes metacharacters literally in argv and pins AWS-RunShellScript", async () => {
    const calls: string[][] = [];
    const responses = [
      runTagResponse(),
      { Command: { CommandId: "cmd-1" } },
      { Status: "Success", ResponseCode: 0, StandardOutputContent: "server-secret" },
    ];
    const runner: AwsCliRunner = {
      run: (args) => {
        calls.push(args);
        return Promise.resolve(JSON.stringify(responses.shift()));
      },
    };
    const execute = createSsmRunCommand({
      runner,
      runTagKey,
      outputLimitBytes: 1024,
      credentialValues: ["server-secret"],
      pollIntervalMs: 0,
    });
    const command = "printf '%s' '$HOME'; touch /tmp/must-not-exist; $(printf ignored)";

    const result = await execute({ instanceId, runtimeUid, command, timeoutSeconds: 20 });
    const described = calls[0] ?? [];
    const sent = calls[1] ?? [];
    const parameters = JSON.parse(sent[sent.indexOf("--parameters") + 1] ?? "{}") as {
      commands?: string[];
      executionTimeout?: string[];
    };

    expect(described).toContain("describe-tags");
    expect(JSON.parse(described[described.indexOf("--filters") + 1] ?? "[]")).toEqual([
      { Name: "resource-id", Values: [instanceId] },
      { Name: "key", Values: [runTagKey] },
    ]);
    expect(sent[sent.indexOf("--document-name") + 1]).toBe(SSM_DOCUMENT_NAME);
    expect(parameters).toEqual({ commands: [command], executionTimeout: ["20"] });
    expect(JSON.stringify({ sent, result })).not.toContain("server-secret");
  });

  test("returns the SSM command ID and cancels it only on the bound instance", async () => {
    const calls: string[][] = [];
    const responses = [runTagResponse(), { Command: { CommandId: "cmd-owned" } }, null];
    const runner: AwsCliRunner = {
      run: (args) => {
        calls.push(args);
        const response = responses.shift();
        return Promise.resolve(response === null ? "" : JSON.stringify(response));
      },
    };
    const execute = createSsmRunCommand({ runner, runTagKey, outputLimitBytes: 1024 });

    const job = await execute.start({
      instanceId,
      runtimeUid,
      command: "true",
      timeoutSeconds: 20,
    });
    expect(job.commandId).toBe("cmd-owned");
    await execute.cancel(job);

    const cancel = calls[2] ?? [];
    expect(cancel.slice(0, 2)).toEqual(["ssm", "cancel-command"]);
    expect(cancel[cancel.indexOf("--command-id") + 1]).toBe("cmd-owned");
    expect(cancel[cancel.indexOf("--instance-ids") + 1]).toBe(instanceId);
  });

  test("truncates stdout and stderr independently and reports original byte counts", async () => {
    const responses = [
      runTagResponse(),
      { Command: { CommandId: "cmd-2" } },
      {
        Status: "Failed",
        ResponseCode: 7,
        StandardOutputContent: "abcdef",
        StandardErrorContent: "uvwxyz",
      },
    ];
    const runner: AwsCliRunner = {
      run: () => Promise.resolve(JSON.stringify(responses.shift())),
    };
    const execute = createSsmRunCommand({
      runner,
      runTagKey,
      outputLimitBytes: 3,
      pollIntervalMs: 0,
    });

    const result = await execute({
      instanceId,
      runtimeUid,
      command: "false",
      timeoutSeconds: 5,
    });
    const { duration_ms: durationMs, ...observed } = result;
    expect(observed).toEqual({
      exit_code: 7,
      stdout: "abc",
      stderr: "uvw",
      stdout_bytes: 6,
      stderr_bytes: 6,
      stdout_truncated: true,
      stderr_truncated: true,
    });
    expect(durationMs).toBeGreaterThanOrEqual(0);
  });

  test("enforces the local command deadline", async () => {
    const runner: AwsCliRunner = {
      run: (args) =>
        Promise.resolve(
          JSON.stringify(
            args.includes("describe-tags") ? runTagResponse() : { Command: { CommandId: "cmd-3" } },
          ),
        ),
    };
    const timestamps = [0, 20_000];
    const execute = createSsmRunCommand({
      runner,
      runTagKey,
      outputLimitBytes: 1024,
      now: () => timestamps.shift() ?? 20_000,
      sleep: () => Promise.resolve(),
    });

    expect.assertions(2);
    try {
      await execute({ instanceId, runtimeUid, command: "sleep 99", timeoutSeconds: 1 });
    } catch (error) {
      expect(error).toBeInstanceOf(SsmRunCommandError);
      expect((error as SsmRunCommandError).code).toBe("timeout");
    }
  });

  test("retries eventual-consistency misses from get-command-invocation", async () => {
    const responses: (string | Error)[] = [
      JSON.stringify(runTagResponse()),
      JSON.stringify({ Command: { CommandId: "cmd-4" } }),
      new Error("InvocationDoesNotExist"),
      JSON.stringify({ Status: "Success", ResponseCode: 0 }),
    ];
    const runner: AwsCliRunner = {
      run: () => {
        const response = responses.shift();
        return response instanceof Error
          ? Promise.reject(response)
          : Promise.resolve(response ?? "{}");
      },
    };
    const execute = createSsmRunCommand({
      runner,
      runTagKey,
      outputLimitBytes: 100,
      pollIntervalMs: 0,
    });

    const result = await execute({
      instanceId,
      runtimeUid,
      command: "true",
      timeoutSeconds: 10,
    });
    expect(result.exit_code).toBe(0);
    expect(responses).toHaveLength(0);
  });

  const runBindingRefusals: [string, AwsCliRunner["run"]][] = [
    ["an untagged instance", () => Promise.resolve(JSON.stringify({ Tags: [] }))],
    ["another run ID", () => Promise.resolve(JSON.stringify(runTagResponse("runtime-b")))],
    ["a failed tag lookup", () => Promise.reject(new Error("lookup failed"))],
  ];
  for (const [reason, run] of runBindingRefusals) {
    test(`refuses ${reason} before send-command`, () => expectRunBindingRefusal(run));
  }

  test("redacts credential values from AWS CLI failures", async () => {
    const dir = await temporaryDirectory();
    const binary = join(dir, "fake-aws-failure");
    await writeFile(
      binary,
      `#!/usr/bin/env bash
echo "failed with $AWS_SESSION_TOKEN" >&2
exit 9
`,
    );
    await chmod(binary, 0o755);
    const runner = createAwsCliRunner({
      binary,
      env: { PATH: process.env.PATH, AWS_SESSION_TOKEN: "session-secret-value" },
    });

    expect.assertions(2);
    try {
      await runner.run(["ssm", "send-command"]);
    } catch (error) {
      expect((error as Error).message).toContain("[redacted]");
      expect((error as Error).message).not.toContain("session-secret-value");
    }
  });
});

async function temporaryDirectory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "remote-shell-test-"));
  tempDirs.push(dir);
  return dir;
}

function runTagResponse(value = runtimeUid) {
  return {
    Tags: [{ ResourceId: instanceId, ResourceType: "instance", Key: runTagKey, Value: value }],
  };
}

function expectRunBindingRefusal(run: AwsCliRunner["run"]): void {
  const calls: string[][] = [];
  const runner: AwsCliRunner = {
    run: (args) => {
      calls.push(args);
      return run(args);
    },
  };
  const execute = createSsmRunCommand({ runner, runTagKey, outputLimitBytes: 100 });

  expect(
    execute({ instanceId, runtimeUid, command: "true", timeoutSeconds: 10 }),
  ).rejects.toMatchObject({ code: "target_not_run_bound" });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain("describe-tags");
}
