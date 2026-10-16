import { describe, expect, test } from "bun:test";

import type { Hop1Identity } from "../../../shared/identity/hop1";
import {
  createRemoteShellRegistry,
  REMOTE_SHELL_TOOL_NAME,
  type RemoteShellAuditEvent,
} from "./registry";
import { SsmRunCommandError, type SsmRunRequest, type SsmRunResult } from "./ssm-run-command";

const binding = {
  issuer: "https://identity.example.com",
  subject: "user-123",
  targets: { controller: "i-0123456789abcdef0" },
};
const TASK_AUTHORITY_CLAIM = ["ste", "ward"].join("");
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
  test("lists and runs only the exact write grant against the bound role", async () => {
    const requests: SsmRunRequest[] = [];
    const events: RemoteShellAuditEvent[] = [];
    const registry = createRemoteShellRegistry({
      identity: taskIdentity("write"),
      bindings: [binding],
      maxTimeoutSeconds: 90,
      execute: (request) => {
        requests.push(request);
        return Promise.resolve(success);
      },
      audit: auditInto(events),
    });

    const listed = registry.listTools();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.name).toBe(REMOTE_SHELL_TOOL_NAME);
    expect(listed[0]?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    const result = await registry.callTool(REMOTE_SHELL_TOOL_NAME, {
      target: "controller",
      command: "pwd && printf '%s\\n' ok",
      timeout_seconds: 20,
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual(success);
    expect(requests).toEqual([
      {
        instanceId: "i-0123456789abcdef0",
        runtimeUid: "runtime-a",
        command: "pwd && printf '%s\\n' ok",
        timeoutSeconds: 20,
      },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      status: "allow",
      runtime_uid: "runtime-a",
      target_role: "controller",
      exit_code: 0,
      stdout_bytes: 3,
    });
    expect(JSON.stringify(events)).not.toContain("pwd");
    expect(JSON.stringify(events)).not.toContain("ok\\n");
    expect(JSON.stringify(events)).not.toContain("i-0123456789abcdef0");
  });

  test("refuses an unapproved action class, interactive token, or missing runtime uid", async () => {
    const identities = [
      taskIdentity("read"),
      { ...taskIdentity("write"), claims: { sub: "user-123" } },
      taskIdentity("write", null),
    ];

    for (const identity of identities) {
      let executed = false;
      const registry = createRemoteShellRegistry({
        identity,
        bindings: [binding],
        maxTimeoutSeconds: 60,
        execute: () => {
          executed = true;
          return Promise.resolve(success);
        },
      });

      expect(registry.listTools()).toEqual([]);
      expect(
        (
          await registry.callTool(REMOTE_SHELL_TOOL_NAME, {
            target: "controller",
            command: "true",
          })
        ).structuredContent,
      ).toEqual({ error: "task_tool_not_approved" });
      expect(executed).toBe(false);
    }
  });

  test("refuses unbound and address-like targets without exposing instance IDs", async () => {
    let executed = false;
    const registry = createRemoteShellRegistry({
      identity: taskIdentity("write"),
      bindings: [binding],
      maxTimeoutSeconds: 60,
      execute: () => {
        executed = true;
        return Promise.resolve(success);
      },
    });

    for (const target of ["worker", "i-0123456789abcdef0", "host.example.com", "10.0.0.4"]) {
      const result = await registry.callTool(REMOTE_SHELL_TOOL_NAME, {
        target,
        command: "true",
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent?.error).toMatch(
        /^remote_shell_(?:invalid_arguments|target_not_bound)$/,
      );
      expect(JSON.stringify(result)).not.toContain("i-0123456789abcdef0");
    }
    expect(executed).toBe(false);
  });

  test("refuses caller-controlled document, instance, run-tag key, and timeout fields", async () => {
    let executed = false;
    const registry = createRemoteShellRegistry({
      identity: taskIdentity("write"),
      bindings: [binding],
      maxTimeoutSeconds: 60,
      execute: () => {
        executed = true;
        return Promise.resolve(success);
      },
    });

    for (const args of [
      { target: "controller", command: "true", document_name: "CustomDocument" },
      { target: "controller", command: "true", instance_id: "i-0123456789abcdef0" },
      { target: "controller", command: "true", run_tag_key: "attacker-controlled" },
      { target: "controller", command: "true", timeout_seconds: 9 },
      { target: "controller", command: "true", timeout_seconds: 61 },
    ]) {
      const result = await registry.callTool(REMOTE_SHELL_TOOL_NAME, args);
      expect(result.structuredContent).toEqual({ error: "remote_shell_invalid_arguments" });
    }
    expect(executed).toBe(false);
  });

  test("returns a structured denial and deny audit when the target is not run-bound", async () => {
    const events: RemoteShellAuditEvent[] = [];
    const registry = createRemoteShellRegistry({
      identity: taskIdentity("write"),
      bindings: [binding],
      maxTimeoutSeconds: 60,
      execute: () => Promise.reject(new SsmRunCommandError("target_not_run_bound")),
      audit: auditInto(events),
    });

    const result = await registry.callTool(REMOTE_SHELL_TOOL_NAME, {
      target: "controller",
      command: "true",
    });
    const serialized = JSON.stringify({ result, events });

    expect(result.structuredContent).toEqual({ error: "remote_shell_target_not_run_bound" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      status: "deny",
      runtime_uid: "runtime-a",
      target_role: "controller",
      error: "remote_shell_target_not_run_bound",
    });
    expect(serialized).not.toContain("i-0123456789abcdef0");
    expect(serialized).not.toContain('"command":"true"');
  });

  test("returns a generic execution error and records no command, output, or credential", async () => {
    const events: RemoteShellAuditEvent[] = [];
    const registry = createRemoteShellRegistry({
      identity: taskIdentity("write"),
      bindings: [binding],
      maxTimeoutSeconds: 60,
      execute: () => Promise.reject(new Error("AWS_SECRET_ACCESS_KEY=server-secret")),
      audit: auditInto(events),
    });

    const result = await registry.callTool(REMOTE_SHELL_TOOL_NAME, {
      target: "controller",
      command: "printf server-secret",
    });
    const serialized = JSON.stringify({ result, events });

    expect(result.structuredContent).toEqual({ error: "remote_shell_execution_failed" });
    expect(serialized).not.toContain("server-secret");
    expect(serialized).not.toContain("AWS_SECRET_ACCESS_KEY");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      status: "error",
      error: "remote_shell_execution_failed",
    });
  });
});

function taskIdentity(action: string, runtimeUid: string | null = "runtime-a"): Hop1Identity {
  return {
    profile: "test",
    issuer: "https://identity.example.com",
    subject: "user-123",
    email: "user@example.com",
    claims: {
      iss: "https://identity.example.com",
      sub: "user-123",
      [TASK_AUTHORITY_CLAIM]: {
        version: 3,
        acting_as: "user",
        ...(runtimeUid ? { runtime_uid: runtimeUid } : {}),
        tools: [
          {
            provider: "remote-shell",
            resource: REMOTE_SHELL_TOOL_NAME,
            action,
          },
        ],
      },
    },
  };
}

function auditInto(events: RemoteShellAuditEvent[]) {
  return {
    emit: (event: RemoteShellAuditEvent): Promise<void> => {
      events.push(event);
      return Promise.resolve();
    },
  };
}
