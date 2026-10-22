import { mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

test("compiled helper runs governed CLI and remote shell through invocation-name symlinks", async () => {
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

  const requests: Array<{ path: string; authorization: string | null; body: unknown }> = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      requests.push({
        path: new URL(request.url).pathname,
        authorization: request.headers.get("authorization"),
        body: await request.json(),
      });
      return new Response(
        '{"type":"stdout","data":"accepted\\n"}\n{"type":"exit","exit_code":0,"truncated":false}\n',
        { headers: { "content-type": "application/x-ndjson" } },
      );
    },
  });

  try {
    const kubectl = join(directory, "kubectl");
    const remoteShell = join(directory, "remote-shell");
    await Promise.all([symlink(executable, kubectl), symlink(executable, remoteShell)]);

    const cli = Bun.spawn([kubectl, "get", "pods"], {
      env: {
        MCP_GW_CLI_URL: `http://127.0.0.1:${server.port}/cli/run`,
        MCP_GW_RUN_TOKEN: "edge-placeholder",
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(await cli.exited).toBe(0);
    expect(await new Response(cli.stdout).text()).toBe("accepted\n");
    expect(await new Response(cli.stderr).text()).toBe("");

    const shell = Bun.spawn([remoteShell, "controller", "--", "uname", "-a"], {
      env: {
        MCP_GW_SHELL_URL: `http://127.0.0.1:${server.port}/shell/run`,
        MCP_GW_RUN_TOKEN: "edge-placeholder",
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(await shell.exited).toBe(0);
    expect(await new Response(shell.stdout).text()).toBe("accepted\n");
    expect(await new Response(shell.stderr).text()).toBe("");
  } finally {
    server.stop(true);
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
  ]);
});
