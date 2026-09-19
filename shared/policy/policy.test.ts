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
    tokenClaims: {
      controlPlane: {
        acting_as: "user",
        runtime_uid: "runtime-uid-a",
        version: 1,
      },
    },
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

  test("global denied operations override ordered allows and OPA allows", async () => {
    const yaml = createYamlPolicyFromString(`
default: allow
guardrails:
  deniedOperations:
    - calendar.events.delete
rules:
  - effect: allow
    match:
      actionClass: destructive
`);
    const policy = new CompositePolicy([
      yaml,
      new OpaPolicyAdapter(() => Promise.resolve({ result: { allow: true } })),
    ]);

    expect(await policy.decide({ ...input, operation: "calendar.events.delete" })).toEqual({
      kind: "deny",
      reason: "Operation disabled by global policy",
      ruleId: "guardrails.denied_operations",
    });
    expect(await policy.decide({ ...input, operation: "calendar.events.list" })).toEqual({
      kind: "allow",
    });
  });

  test("matches canonical operations in ordinary YAML rules", async () => {
    const policy = createYamlPolicyFromString(`
default: allow
rules:
  - id: mail-send-review
    effect: deny
    match:
      operation: gmail.users.messages.send
`);
    expect(await policy.decide({ ...input, operation: "gmail.users.messages.send" })).toEqual({
      kind: "deny",
      reason: "YAML policy deny",
      ruleId: "mail-send-review",
    });
    expect(await policy.decide({ ...input, operation: "gmail.users.messages.get" })).toEqual({
      kind: "allow",
    });
  });

  test("assigns stable IDs to unlabeled ordered decisions and the default", async () => {
    const config = `
default: deny
rules:
  - effect: approval_required
    match: { operation: drive.files.delete }
  - effect: deny
    match: { operation: calendar.events.delete }
`;
    for (const policy of [createYamlPolicyFromString(config), createYamlPolicyFromString(config)]) {
      expect(await policy.decide({ ...input, operation: "drive.files.delete" })).toMatchObject({
        kind: "approval_required",
        ruleId: "yaml.rule.1",
      });
      expect(await policy.decide({ ...input, operation: "calendar.events.delete" })).toMatchObject({
        kind: "deny",
        ruleId: "yaml.rule.2",
      });
      expect(await policy.decide({ ...input, operation: "drive.files.get" })).toMatchObject({
        kind: "deny",
        ruleId: "yaml.default",
      });
    }
  });

  test("rejects malformed hard guardrails at policy startup", () => {
    expect(() =>
      createYamlPolicyFromString('guardrails: { deniedOperations: ["not a command"] }'),
    ).toThrow();
    expect(() =>
      createYamlPolicyFromString("guardrails: { deniedOperations: [], unknown: true }"),
    ).toThrow();
    expect(() =>
      createYamlPolicyFromString(
        "guardrails: { deniedOperations: [calendar.events.deltee] }",
        new Set(["calendar.events.delete"]),
      ),
    ).toThrow("Unknown guardrail operation");
  });

  test("global outbound mail domains override ordinary and OPA allows", async () => {
    const policy = new CompositePolicy([
      createYamlPolicyFromString(`
default: allow
guardrails:
  outboundEmail:
    allowedRecipientDomains: [example.org]
rules:
  - effect: allow
`),
      new OpaPolicyAdapter(() => Promise.resolve({ result: { allow: true } })),
    ]);
    const send = { ...input, operation: "gmail.users.messages.send" };
    expect(
      await policy.decide({
        ...send,
        outboundEmail: { kind: "verified", recipientDomains: ["example.org", "team.example.org"] },
      }),
    ).toEqual({ kind: "allow" });
    expect(
      await policy.decide({
        ...send,
        outboundEmail: { kind: "verified", recipientDomains: ["example.org", "evil-example.org"] },
      }),
    ).toEqual({
      kind: "deny",
      reason: "Outbound email recipient domain is not allowed",
      ruleId: "guardrails.outbound_email_domain",
    });
    expect(await policy.decide(send)).toEqual({
      kind: "deny",
      reason: "Outbound email recipients cannot be verified",
      ruleId: "guardrails.outbound_email_opaque",
    });
    expect(await policy.decide({ ...input, operation: "gmail.users.messages.get" })).toEqual({
      kind: "allow",
    });
  });

  test("validates outbound domain configuration at startup", () => {
    for (const domain of [
      "",
      "https://example.org",
      "*.example.org",
      "example.org/path",
      "-bad.org",
      "a..org",
      "com",
    ]) {
      expect(() =>
        createYamlPolicyFromString(
          `guardrails:\n  outboundEmail:\n    allowedRecipientDomains: ["${domain}"]`,
        ),
      ).toThrow();
    }
    expect(() => createYamlPolicyFromString("guardrails: { outboundEmail: {} }")).toThrow();
    expect(() =>
      createYamlPolicyFromString(
        "guardrails: { outboundEmail: { allowedRecipientDomains: [example.org], unknown: true } }",
      ),
    ).toThrow();
    expect(() =>
      createYamlPolicyFromString("guardrails: { outboundEmail: { allowedRecipientDomains: [] } }"),
    ).toThrow();
  });

  test("maps OPA allow responses to policy decisions without exposing raw args", async () => {
    const adapter = new OpaPolicyAdapter((request) => {
      expect(request.input.tool).toBe("google_drive_files_delete");
      expect(request.input.tokenClaims).toEqual(input.tokenClaims);
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

  test("sends only normalized domains, not mail arguments, to OPA", async () => {
    const secretAddress = "someone@private.example";
    const raw = Buffer.from(`To: ${secretAddress}\r\n\r\nSecret body`).toString("base64url");
    const adapter = new OpaPolicyAdapter((request) => {
      expect(request.input.outboundEmail).toEqual({
        kind: "verified",
        recipientDomains: ["private.example"],
      });
      expect(request.input.args).toEqual({});
      expect(JSON.stringify(request)).not.toContain(secretAddress);
      expect(JSON.stringify(request)).not.toContain(raw);
      return Promise.resolve({ result: { allow: true } });
    });
    expect(
      await adapter.decide({
        ...input,
        operation: "gmail.users.messages.send",
        outboundEmail: { kind: "verified", recipientDomains: ["private.example"] },
        args: { json: { raw }, to: secretAddress },
      }),
    ).toEqual({ kind: "allow" });
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
      ruleId: "yaml.rule.3",
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
      ruleId: "yaml.default",
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
      ruleId: "yaml.rule.1",
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
