import { describe, expect, test } from "bun:test";

import {
  AllowAllPolicy,
  CompositePolicy,
  createOpaPolicyFromUrl,
  createYamlPolicyFromString,
  OpaPolicyAdapter,
} from "./policy";

describe("policy primitives", () => {
  const input = {
    principal: "user@example.com",
    tool: "google_drive_files_delete",
    service: "drive",
    actionClass: "destructive" as const,
    scopes: ["https://www.googleapis.com/auth/drive"],
    args: {
      fileId: "file-123",
      accessToken: "must-not-leak",
    },
  };

  test("allows by default when no org policy is configured", async () => {
    expect(await new AllowAllPolicy().decide(input)).toEqual({ kind: "allow" });
  });

  test("maps OPA allow responses to policy decisions without exposing raw args", async () => {
    const adapter = new OpaPolicyAdapter((request) => {
      expect(request.input.tool).toBe("google_drive_files_delete");
      expect(request.input.args).toEqual({
        fileId: "file-123",
        accessToken: "[redacted]",
      });

      return Promise.resolve({
        result: { allow: false, reason: "delete disabled for this tenant" },
      });
    });

    expect(await adapter.decide(input)).toEqual({
      kind: "deny",
      reason: "delete disabled for this tenant",
    });
  });

  test("maps OPA approval-required responses explicitly", async () => {
    const adapter = new OpaPolicyAdapter(() =>
      Promise.resolve({
        result: { allow: false, approval_required: true, reason: "approval required" },
      }),
    );

    expect(await adapter.decide(input)).toEqual({
      kind: "approval_required",
      reason: "approval required",
    });
  });

  test("posts policy inputs to an OPA endpoint", async () => {
    const policy = createOpaPolicyFromUrl("http://opa:8181/v1/data/mcp/allow", (url, init) => {
      expect(url).toBe("http://opa:8181/v1/data/mcp/allow");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({ "content-type": "application/json" });
      expect(typeof init?.body).toBe("string");
      const body = typeof init?.body === "string" ? init.body : "";
      expect(JSON.parse(body)).toMatchObject({
        input: {
          principal: "user@example.com",
          tool: "google_drive_files_delete",
        },
      });

      return Promise.resolve(
        new Response(
          JSON.stringify({
            result: { allow: false, reason: "blocked by OPA" },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
    });

    expect(await policy.decide(input)).toEqual({
      kind: "deny",
      reason: "blocked by OPA",
    });
  });

  test("evaluates YAML policy rules without code changes", async () => {
    const policy = createYamlPolicyFromString(`
default: deny
rules:
  - effect: allow
    match:
      actionClass: read
  - effect: allow
    match:
      actionClass: write
      service:
        - docs
        - sheets
        - slides
        - drive
  - effect: approval_required
    reason: Destructive Google Workspace actions require approval
    match:
      actionClass: destructive
`);

    expect(
      await policy.decide({
        ...input,
        tool: "google_drive_files_list",
        actionClass: "read",
      }),
    ).toEqual({ kind: "allow" });

    expect(
      await policy.decide({
        ...input,
        tool: "google_drive_files_delete",
        actionClass: "destructive",
      }),
    ).toEqual({
      kind: "approval_required",
      reason: "Destructive Google Workspace actions require approval",
    });

    expect(
      await policy.decide({
        ...input,
        tool: "google_gmail_threads_modify",
        service: "gmail",
        actionClass: "write",
      }),
    ).toEqual({
      kind: "deny",
      reason: "YAML policy default deny",
    });
  });

  test("composes YAML and OPA policies with most restrictive result winning", async () => {
    const localPolicy = createYamlPolicyFromString(`
default: allow
rules:
  - effect: deny
    reason: Deletes are disabled locally
    match:
      actionClass: destructive
`);
    const remotePolicy = new OpaPolicyAdapter(() => Promise.resolve({ result: { allow: true } }));

    expect(await new CompositePolicy([localPolicy, remotePolicy]).decide(input)).toEqual({
      kind: "deny",
      reason: "Deletes are disabled locally",
    });

    const localAllow = createYamlPolicyFromString("default: allow\n");
    const remoteDeny = new OpaPolicyAdapter(() =>
      Promise.resolve({ result: { allow: false, reason: "blocked by OPA" } }),
    );

    expect(await new CompositePolicy([localAllow, remoteDeny]).decide(input)).toEqual({
      kind: "deny",
      reason: "blocked by OPA",
    });
  });
});
