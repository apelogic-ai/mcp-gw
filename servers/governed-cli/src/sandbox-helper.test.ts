import { mkdtemp, symlink } from "node:fs/promises";
import { connect, createServer } from "node:net";
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

    // An empty environment, as under some process supervisors: the options alone configure it.
    const optionsOnly = Bun.spawn(
      [
        executable,
        "--run-token",
        "edge-placeholder",
        "--cli-url",
        `${origin}/cli/run`,
        "--operation",
        "kubectl",
        "get",
        "nodes",
      ],
      { env: {}, stderr: "pipe", stdout: "pipe" },
    );
    expect(await optionsOnly.exited).toBe(0);
    expect(await new Response(optionsOnly.stdout).text()).toBe("accepted\n");
    expect(await new Response(optionsOnly.stderr).text()).toBe("");

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
      body: { cli: "kubectl", args: ["get", "nodes"] },
    },
    {
      path: "/cli/run",
      authorization: "Bearer edge-placeholder",
      body: { cli: "kubectl", args: ["get", "services"] },
    },
  ]);
  expect(remoteRuns).toEqual([
    {
      instanceId: "i-0123456789abcdef0",
      command: "uname -a",
      timeoutSeconds: 60,
    },
  ]);
});

test("compiled helper reaches an HTTPS gateway through an egress proxy with an empty environment", async () => {
  // Under the OpenShell supervisor the helper sees no environment, so it can't find the sandbox's
  // egress proxy or the CA of the proxy's TLS termination. The wrappers pass both as options.
  const directory = await mkdtemp(join(tmpdir(), "mcp-gw-sandbox-helper-egress-"));
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

  const certificate = join(directory, "gateway.crt");
  const key = join(directory, "gateway.key");
  const openssl = Bun.spawn(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=gateway.test",
      "-addext",
      "subjectAltName=DNS:gateway.test",
      "-keyout",
      key,
      "-out",
      certificate,
    ],
    { stderr: "pipe", stdout: "pipe" },
  );
  expect(await openssl.exited, await new Response(openssl.stderr).text()).toBe(0);

  const requests: { path: string; authorization: string | null; body: unknown }[] = [];
  const gateway = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls: { cert: Bun.file(certificate), key: Bun.file(key) },
    fetch: async (request) => {
      requests.push({
        path: new URL(request.url).pathname,
        authorization: request.headers.get("authorization"),
        body: await request.json(),
      });
      return new Response(
        '{"type":"stdout","data":"through proxy\\n"}\n{"type":"exit","exit_code":0,"truncated":false}\n',
      );
    },
  });
  const gatewayPort = gateway.port;
  if (gatewayPort === undefined) throw new Error("Test gateway did not bind a port");

  // A minimal CONNECT proxy that records each tunnel request and forwards it to the gateway.
  const tunnels: string[] = [];
  const proxy = createServer((client) => {
    client.once("data", (head: Buffer) => {
      tunnels.push(head.toString("latin1").split("\r\n")[0] ?? "");
      const upstream = connect(gatewayPort, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    });
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  if (address === null || typeof address === "string") throw new Error("Proxy did not bind");
  const proxyUrl = `http://127.0.0.1:${String(address.port)}`;

  const run = async (egress: readonly string[]) => {
    const helper = Bun.spawn(
      [
        executable,
        ...egress,
        "--run-token",
        "edge-placeholder",
        "--cli-url",
        "https://gateway.test/cli/run",
        "--operation",
        "kubectl",
        "get",
        "pods",
      ],
      { env: {}, stderr: "pipe", stdout: "pipe" },
    );
    return {
      exitCode: await helper.exited,
      stdout: await new Response(helper.stdout).text(),
      stderr: await new Response(helper.stderr).text(),
    };
  };

  try {
    expect(await run(["--proxy", proxyUrl, "--ca-file", certificate])).toEqual({
      exitCode: 0,
      stdout: "through proxy\n",
      stderr: "",
    });
    expect(tunnels).toEqual(["CONNECT gateway.test:443 HTTP/1.1"]);
    expect(requests).toEqual([
      {
        path: "/cli/run",
        authorization: "Bearer edge-placeholder",
        body: { cli: "kubectl", args: ["get", "pods"] },
      },
    ]);

    // Without the CA the proxy's certificate is untrusted; without the proxy there is no route.
    const failed = { exitCode: 125, stdout: "", stderr: "CLI request failed\n" };
    expect(await run(["--proxy", proxyUrl])).toEqual(failed);
    expect(await run(["--ca-file", certificate])).toEqual(failed);
    expect(requests).toHaveLength(1);
  } finally {
    proxy.close();
    await gateway.stop(true);
  }
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
        remote_shell_targets: { controller: "i-0123456789abcdef0" },
        tools: [REMOTE_SHELL_GRANT],
      },
    },
  };
}
