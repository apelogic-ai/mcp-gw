import { describe, expect, test } from "bun:test";

import { createRemoteShellHandler, loadRemoteShellConfig } from "./main";
import type { Hop1Identity } from "../../../shared/identity/hop1";

const issuer = {
  name: "control-plane",
  issuer: "https://identity.example.com",
  jwksUrl: "https://identity.example.com/.well-known/jwks.json",
  audiences: ["mcp"],
  allowedAlgorithms: ["RS256"],
  emailClaim: "email",
};
const binding = {
  issuer: "https://identity.example.com",
  subject: "user-123",
  targets: { controller: "i-0123456789abcdef0" },
};
const TASK_AUTHORITY_CLAIM = ["ste", "ward"].join("");

describe("remote shell configuration", () => {
  test("loads verified-principal bindings and bounded defaults", () => {
    const config = loadRemoteShellConfig({
      HOP1_ISSUERS_JSON: JSON.stringify([issuer]),
      REMOTE_SHELL_BINDINGS_JSON: JSON.stringify([binding]),
    });

    expect(config).toMatchObject({
      port: 8080,
      awsCliPath: "/usr/local/bin/aws",
      maxTimeoutSeconds: 60,
      maxOutputBytes: 24 * 1024,
      bindings: [binding],
    });
  });

  test("rejects malformed, duplicate, or address-shaped bindings", () => {
    const invalidBindings = [
      [],
      [binding, binding],
      [{ ...binding, targets: { "host.example.com": "i-0123456789abcdef0" } }],
      [{ ...binding, targets: { controller: "host.example.com" } }],
    ];

    for (const bindings of invalidBindings) {
      expect(() =>
        loadRemoteShellConfig({
          HOP1_ISSUERS_JSON: JSON.stringify([issuer]),
          REMOTE_SHELL_BINDINGS_JSON: JSON.stringify(bindings),
        }),
      ).toThrow();
    }
  });

  test("serves an authenticated MCP call without forwarding the bearer credential", async () => {
    let observedAuthorization: string | undefined;
    const identity: Hop1Identity = {
      profile: "test",
      issuer: binding.issuer,
      subject: binding.subject,
      email: "user@example.com",
      claims: {
        [TASK_AUTHORITY_CLAIM]: {
          version: 3,
          acting_as: "user",
          runtime_uid: "runtime-a",
          tools: [{ provider: "remote-shell", resource: "remote_shell_run", action: "write" }],
        },
      },
    };
    const handler = createRemoteShellHandler({
      authenticate: (token) => {
        observedAuthorization = token;
        return Promise.resolve(identity);
      },
      bindings: [binding],
      maxTimeoutSeconds: 60,
      execute: () =>
        Promise.resolve({
          exit_code: 0,
          stdout: "ok",
          stderr: "",
          stdout_bytes: 2,
          stderr_bytes: 0,
          stdout_truncated: false,
          stderr_truncated: false,
          duration_ms: 1,
        }),
    });

    const response = await handler(
      new Request("http://remote-shell/mcp", {
        method: "POST",
        headers: { authorization: "Bearer hop1-secret" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "remote_shell_run",
            arguments: { target: "controller", command: "true" },
          },
        }),
      }),
    );
    const body = await response.text();

    expect(observedAuthorization).toBe("hop1-secret");
    expect(response.status).toBe(200);
    expect(body).toContain('"exit_code":0');
    expect(body).not.toContain("hop1-secret");
  });
});
