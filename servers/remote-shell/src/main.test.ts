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
describe("remote shell configuration", () => {
  test("loads verified issuers and bounded defaults without mutable target configuration", () => {
    const config = loadRemoteShellConfig({
      HOP1_ISSUERS_JSON: JSON.stringify([issuer]),
    });

    expect(config).toMatchObject({
      port: 8080,
      awsCliPath: "/usr/local/bin/aws",
      maxTimeoutSeconds: 60,
      maxOutputBytes: 24 * 1024,
      requestLimits: { maxBodyBytes: 17 * 1024, maxCommandBytes: 16 * 1024 },
      jobLimits: { maxJobs: 64, maxRunningJobsPerOwner: 4, retentionSeconds: 30 * 60 },
    });
    expect(config).not.toHaveProperty("bindings");
    expect(config).not.toHaveProperty("runTagKey");
  });

  test("loads and validates request and job limits", () => {
    const env = {
      HOP1_ISSUERS_JSON: JSON.stringify([issuer]),
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
