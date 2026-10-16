import { describe, expect, test } from "bun:test";

import { loadRemoteShellConfig } from "./main";

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

describe("remote shell configuration", () => {
  test("loads verified-principal bindings and bounded defaults", () => {
    const config = loadRemoteShellConfig({
      HOP1_ISSUERS_JSON: JSON.stringify([issuer]),
      REMOTE_SHELL_BINDINGS_JSON: JSON.stringify([binding]),
    });

    expect(config).toMatchObject({
      port: 8080,
      awsCliPath: "/usr/local/bin/aws",
      runTagKey: "hypershell:run-id",
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
});
