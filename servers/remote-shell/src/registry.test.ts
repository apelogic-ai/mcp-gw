import { describe, expect, test } from "bun:test";

import type { Hop1Identity } from "../../../shared/identity/hop1";
import {
  createRemoteShellRegistry,
  REMOTE_SHELL_TOOL_NAME,
  type RemoteShellAuditEvent,
} from "./registry";
import { SsmRunCommandError, type SsmRunRequest, type SsmRunResult } from "./ssm-run-command";

const claim = ["ste", "ward"].join("");
const binding = {
  issuer: "https://identity.example.com",
  subject: "user-123",
  targets: { controller: "i-0123456789abcdef0" },
};
const success: SsmRunResult = {
  exit_code: 0,
  stdout: "ok\n",
  stderr: "",
  stdout_bytes: 3,
  stderr_bytes: 0,
  stdout_truncated: false,
  stderr_truncated: false,
  duration_ms: 12,
};

describe("remote shell registry", () => {
  test("runs only the exact write grant against the bound role", async () => {
    const requests: SsmRunRequest[] = [];
    const events: RemoteShellAuditEvent[] = [];
    const registry = createRemoteShellRegistry({
      ...baseOptions(events),
      execute: (request) => {
        requests.push(request);
        return Promise.resolve(success);
      },
    });

    expect(registry.listTools().map((tool) => tool.name)).toEqual([REMOTE_SHELL_TOOL_NAME]);
    const result = await registry.callTool(REMOTE_SHELL_TOOL_NAME, {
      target: "controller",
      command: "pwd && printf ok",
      timeout_seconds: 20,
    });
    expect(result.structuredContent).toEqual(success);
    expect(requests).toEqual([
      {
        instanceId: "i-0123456789abcdef0",
        runtimeUid: "runtime-a",
        command: "pwd && printf ok",
        timeoutSeconds: 20,
      },
    ]);
    expect(events[0]).toMatchObject({ status: "allow", runtime_uid: "runtime-a", exit_code: 0 });
    expect(JSON.stringify(events)).not.toMatch(/pwd|i-0123456789abcdef0/);
  });

  test("hides and refuses the tool without exact Task authority", async () => {
    const identities = [
      taskIdentity("read"),
      { ...taskIdentity("write"), claims: { sub: "user-123" } },
      taskIdentity("write", null),
    ];
    for (const identity of identities) {
      let executed = false;
      const registry = createRemoteShellRegistry({
        ...baseOptions(),
        identity,
        execute: () => {
          executed = true;
          return Promise.resolve(success);
        },
      });
      expect(registry.listTools()).toEqual([]);
      expect(
        (await registry.callTool(REMOTE_SHELL_TOOL_NAME, { target: "controller", command: "true" }))
          .structuredContent,
      ).toEqual({ error: "task_tool_not_approved" });
      expect(executed).toBe(false);
    }
  });

  test("refuses unbound targets and caller-controlled execution fields", async () => {
    let executed = false;
    const registry = createRemoteShellRegistry({
      ...baseOptions(),
      execute: () => {
        executed = true;
        return Promise.resolve(success);
      },
    });
    const refused = [
      { target: "worker", command: "true" },
      { target: "i-0123456789abcdef0", command: "true" },
      { target: "controller", command: "true", document_name: "Custom" },
      { target: "controller", command: "true", instance_id: "i-0123456789abcdef0" },
      { target: "controller", command: "true", run_tag_key: "attacker-controlled" },
      { target: "controller", command: "true", timeout_seconds: 9 },
    ];
    for (const args of refused) {
      expect((await registry.callTool(REMOTE_SHELL_TOOL_NAME, args)).isError).toBe(true);
    }
    expect(executed).toBe(false);
  });

  test("returns a structured deny when the target is not run-bound", async () => {
    const events: RemoteShellAuditEvent[] = [];
    const registry = createRemoteShellRegistry({
      ...baseOptions(events),
      execute: () => Promise.reject(new SsmRunCommandError("target_not_run_bound")),
    });
    const result = await registry.callTool(REMOTE_SHELL_TOOL_NAME, {
      target: "controller",
      command: "true",
    });
    expect(result.structuredContent).toEqual({ error: "remote_shell_target_not_run_bound" });
    expect(events[0]).toMatchObject({ status: "deny", error: "remote_shell_target_not_run_bound" });
  });

  test("does not expose command, output, or credentials on execution failure", async () => {
    const events: RemoteShellAuditEvent[] = [];
    const registry = createRemoteShellRegistry({
      ...baseOptions(events),
      execute: () => Promise.reject(new Error("AWS_SECRET_ACCESS_KEY=server-secret")),
    });
    const result = await registry.callTool(REMOTE_SHELL_TOOL_NAME, {
      target: "controller",
      command: "printf server-secret",
    });
    expect(result.structuredContent).toEqual({ error: "remote_shell_execution_failed" });
    expect(JSON.stringify({ result, events })).not.toContain("server-secret");
  });
});

function baseOptions(events: RemoteShellAuditEvent[] = []) {
  return {
    identity: taskIdentity("write"),
    bindings: [binding],
    maxTimeoutSeconds: 60,
    execute: () => Promise.resolve(success),
    audit: {
      emit: (event: RemoteShellAuditEvent) =>
        Promise.resolve(events.push(event)).then(() => undefined),
    },
  };
}

function taskIdentity(action: string, runtimeUid: string | null = "runtime-a"): Hop1Identity {
  return {
    profile: "test",
    issuer: binding.issuer,
    subject: binding.subject,
    email: "user@example.com",
    claims: {
      [claim]: {
        version: 3,
        acting_as: "user",
        ...(runtimeUid ? { runtime_uid: runtimeUid } : {}),
        tools: [{ provider: "remote-shell", resource: REMOTE_SHELL_TOOL_NAME, action }],
      },
    },
  };
}
