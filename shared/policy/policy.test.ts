import { describe, expect, test } from "bun:test";

import { AllowAllPolicy, createOpaPolicyFromUrl, OpaPolicyAdapter } from "./policy";

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
});
