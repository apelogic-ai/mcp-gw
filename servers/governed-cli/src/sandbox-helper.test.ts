import { mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import type { Hop1Identity } from "../../../shared/identity/hop1";
import { createRemoteShellHttpHandler, REMOTE_SHELL_GRANT } from "../../remote-shell/src/http";
import type {
  SsmRunCommand,
  SsmRunRequest,
  SsmRunResult,
} from "../../remote-shell/src/ssm-run-command";

test("compiled helper runs explicit operations and the invocation-name fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-gw-sandbox-helper-"));
  const executable = join(directory, "mcp-gw-sandbox-helper");
  const build = Bun.spawn(
    [
      "bun",
      "build",
      "--compile",
      "--outfile",
      executable,
      "servers/governed-cli/src/sandbox-helper.ts",
    ],
    { stderr: "pipe", stdout: "pipe" },
  );
  const buildStderr = await new Response(build.stderr).text();
  expect(await build.exited, buildStderr).toBe(0);

  const requests: { path: string; authorization: string | null; body: unknown }[] = [];
  const remoteRuns: SsmRunRequest[] = [];
  const remoteResult: SsmRunResult = {
    exit_code: 0,
    stdout: "accepted\n",
    stderr: "",
    stdout_bytes: 9,
    stderr_bytes: 0,
    stdout_truncated: false,
    stderr_truncated: false,
    duration_ms: 1,
  };
  const execute = (request: SsmRunRequest) => {
    remoteRuns.push(request);
    return Promise.resolve(remoteResult);
  };
  const ssm = Object.assign(execute, {
    start: () => Promise.reject(new Error("not used")),
    wait: () => Promise.reject(new Error("not used")),
    cancel: () => Promise.reject(new Error("not used")),
  }) satisfies SsmRunCommand;
  const shellHandler = createRemoteShellHttpHandler({
    authenticate: () => Promise.resolve(taskIdentity()),
    bindings: [
      {
        issuer: "https://identity.example.com",
        subject: "user-123",
        targets: { controller: "target-fixture" },
      },
    ],
    maxTimeoutSeconds: 60,
    requestLimits: { maxBodyBytes: 17 * 1024, maxCommandBytes: 16 * 1024 },
    jobLimits: { maxJobs: 4, maxRunningJobsPerOwner: 1, retentionSeconds: 60 },
    ssm,
  });
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      requests.push({
        path,
        authorization: request.headers.get("authorization"),
        body: await request.clone().json(),
      });
      if (path === "/shell/run") return shellHandler(request);
      return new Response(
        '{"type":"stdout","data":"accepted\\n"}\n{"type":"exit","exit_code":0,"truncated":false}\n',
        { headers: { "content-type": "application/x-ndjson" } },
      );
    },
  });
  const port = server.port;
  if (port === undefined) throw new Error("Test server did not bind a port");
  const origin = `http://127.0.0.1:${String(port)}`;

  try {
    const kubectl = join(directory, "kubectl");
    await symlink(executable, kubectl);

    const cli = Bun.spawn([executable, "--operation", "kubectl", "get", "pods"], {
      env: {
        MCP_GW_CLI_URL: `${origin}/cli/run`,
        MCP_GW_RUN_TOKEN: "edge-placeholder",
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(await cli.exited).toBe(0);
    expect(await new Response(cli.stdout).text()).toBe("accepted\n");
    expect(await new Response(cli.stderr).text()).toBe("");

    const shell = Bun.spawn(
      [executable, "--operation", "remote-shell", "controller", "--", "uname", "-a"],
      {
        env: {
          MCP_GW_SHELL_URL: `${origin}/shell/run`,
          MCP_GW_RUN_TOKEN: "edge-placeholder",
        },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    expect(await shell.exited).toBe(0);
    expect(await new Response(shell.stdout).text()).toBe("accepted\n");
    expect(await new Response(shell.stderr).text()).toBe("");

    const fallback = Bun.spawn([kubectl, "get", "services"], {
      env: {
        MCP_GW_CLI_URL: `${origin}/cli/run`,
        MCP_GW_RUN_TOKEN: "edge-placeholder",
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(await fallback.exited).toBe(0);
    expect(await new Response(fallback.stdout).text()).toBe("accepted\n");
    expect(await new Response(fallback.stderr).text()).toBe("");
  } finally {
    await server.stop(true);
  }

  expect(requests).toEqual([
    {
      path: "/cli/run",
      authorization: "Bearer edge-placeholder",
      body: { cli: "kubectl", args: ["get", "pods"] },
    },
    {
      path: "/shell/run",
      authorization: "Bearer edge-placeholder",
      body: { target: "controller", command: "uname -a" },
    },
    {
      path: "/cli/run",
      authorization: "Bearer edge-placeholder",
      body: { cli: "kubectl", args: ["get", "services"] },
    },
  ]);
  expect(remoteRuns).toEqual([
    {
      instanceId: "target-fixture",
      runtimeUid: "runtime-a",
      command: "uname -a",
      timeoutSeconds: 60,
    },
  ]);
});

function taskIdentity(): Hop1Identity {
  return {
    profile: "test",
    issuer: "https://identity.example.com",
    subject: "user-123",
    email: "user@example.com",
    claims: {
      [["ste", "ward"].join("")]: {
        version: 3,
        acting_as: "user",
        runtime_uid: "runtime-a",
        tools: [REMOTE_SHELL_GRANT],
      },
    },
  };
}
