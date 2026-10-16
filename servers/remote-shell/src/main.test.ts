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
      requestLimits: { maxBodyBytes: 17 * 1024, maxCommandBytes: 16 * 1024 },
      jobLimits: { maxJobs: 64, maxRunningJobsPerOwner: 4, retentionSeconds: 30 * 60 },
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

  test("loads and validates request and job limits", () => {
    const env = {
      HOP1_ISSUERS_JSON: JSON.stringify([issuer]),
      REMOTE_SHELL_BINDINGS_JSON: JSON.stringify([binding]),
      REMOTE_SHELL_MAX_COMMAND_BYTES: "100",
      REMOTE_SHELL_MAX_BODY_BYTES: "200",
      REMOTE_SHELL_MAX_JOBS: "3",
      REMOTE_SHELL_MAX_RUNNING_JOBS_PER_OWNER: "2",
      REMOTE_SHELL_JOB_RETENTION_SECONDS: "45",
    };
    expect(loadRemoteShellConfig(env)).toMatchObject({
      requestLimits: { maxCommandBytes: 100, maxBodyBytes: 200 },
      jobLimits: { maxJobs: 3, maxRunningJobsPerOwner: 2, retentionSeconds: 45 },
    });
    expect(() =>
      loadRemoteShellConfig({ ...env, REMOTE_SHELL_MAX_RUNNING_JOBS_PER_OWNER: "4" }),
    ).toThrow("Remote-shell numeric configuration is invalid");
    expect(() => loadRemoteShellConfig({ ...env, REMOTE_SHELL_MAX_BODY_BYTES: "99" })).toThrow(
      "Remote-shell numeric configuration is invalid",
    );
  });
});
