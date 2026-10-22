import { describe, expect, test } from "bun:test";
import { runCliShim, runSandboxHelper } from "./shim";

function writer(values: string[]) {
  return { write: (data: string) => values.push(data) };
}

describe("governed CLI shim", () => {
  test("forwards streamed output live and exits with the remote code", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const encoder = new TextEncoder();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const requests: { url: string; authorization: string | null; body: unknown }[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        value.enqueue(encoder.encode('{"type":"stdout","data":"first\\n"}\n'));
      },
    });
    const running = runCliShim({
      cli: "fixture",
      args: ["inspect", ";", "|", "$(x)"],
      endpoint: "https://cli.example.com/cli/run",
      token: "run-token",
      stdout: writer(stdout),
      stderr: writer(stderr),
      fetch: (input, init) => {
        requests.push({
          url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
          authorization: new Headers(init?.headers).get("authorization"),
          body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
        });
        return Promise.resolve(new Response(stream));
      },
    });

    await Bun.sleep(0);
    expect(stdout).toEqual(["first\n"]);
    controller?.enqueue(encoder.encode('{"type":"stderr","data":"warn\\n"}\n'));
    controller?.enqueue(encoder.encode('{"type":"exit","exit_code":9,"truncated":false}\n'));
    controller?.close();

    expect(await running).toBe(9);
    expect(stderr).toEqual(["warn\n"]);
    expect(requests).toEqual([
      {
        url: "https://cli.example.com/cli/run",
        authorization: "Bearer run-token",
        body: { cli: "fixture", args: ["inspect", ";", "|", "$(x)"] },
      },
    ]);
  });

  test("reports HTTP and protocol failures without echoing response bodies", async () => {
    for (const response of [
      new Response('{"error":"provider-secret"}', { status: 403 }),
      new Response('{"type":"stdout","data":"missing exit"}\n'),
    ]) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      expect(
        await runCliShim({
          cli: "fixture",
          args: ["inspect"],
          endpoint: "https://cli.example.com/cli/run",
          token: "run-token",
          stdout: writer(stdout),
          stderr: writer(stderr),
          fetch: () => Promise.resolve(response),
        }),
      ).toBe(1);
      expect(stdout).toEqual(response.status === 403 ? [] : ["missing exit"]);
      expect(stderr.join("")).toBe("CLI request failed\n");
      expect(stderr.join("")).not.toContain("provider-secret");
    }
  });

  test("selects governed CLI and remote shell by invocation name", async () => {
    const requests: Array<{ url: string; authorization: string | null; body: unknown }> = [];
    const fetch = (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        authorization: new Headers(init?.headers).get("authorization"),
        body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
      });
      return Promise.resolve(
        new Response('{"type":"stdout","data":"ok\\n"}\n{"type":"exit","exit_code":0}\n'),
      );
    };

    expect(
      await runSandboxHelper({
        argv0: "/usr/local/bin/kubectl",
        args: ["get", "pods", ";", "|", "$(literal)"],
        env: {
          MCP_GW_CLI_URL: "http://127.0.0.1:8080/cli/run",
          MCP_GW_RUN_TOKEN: "edge-placeholder",
        },
        fetch,
        stdout: writer([]),
        stderr: writer([]),
      }),
    ).toBe(0);
    expect(
      await runSandboxHelper({
        argv0: "/usr/local/bin/remote-shell",
        args: ["controller", "--", "printf", "hello world"],
        env: {
          MCP_GW_SHELL_URL: "https://gateway.example.com/shell/run",
          MCP_GW_RUN_TOKEN: "edge-placeholder",
        },
        fetch,
        stdout: writer([]),
        stderr: writer([]),
      }),
    ).toBe(0);

    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:8080/cli/run",
        authorization: "Bearer edge-placeholder",
        body: { cli: "kubectl", args: ["get", "pods", ";", "|", "$(literal)"] },
      },
      {
        url: "https://gateway.example.com/shell/run",
        authorization: "Bearer edge-placeholder",
        body: { target: "controller", command: "printf hello world" },
      },
    ]);
  });

  test("refuses unsafe or missing configuration before making a request", async () => {
    const stderr: string[] = [];
    let requests = 0;
    const fetch = () => {
      requests += 1;
      return Promise.resolve(new Response());
    };

    for (const env of [
      { MCP_GW_CLI_URL: "https://gateway.example.com/cli/run" },
      {
        MCP_GW_CLI_URL: "http://192.0.2.1/cli/run",
        MCP_GW_RUN_TOKEN: "edge-placeholder",
      },
      {
        MCP_GW_CLI_URL: "https://gateway.example.com/cli/run",
        MCP_GW_RUN_TOKEN_FILE: "/run/secrets/token",
      },
    ]) {
      expect(
        await runSandboxHelper({
          argv0: "kubectl",
          args: ["get", "pods"],
          env,
          fetch,
          stdout: writer([]),
          stderr: writer(stderr),
        }),
      ).toBe(1);
    }

    expect(requests).toBe(0);
    expect(stderr.join("")).not.toContain("edge-placeholder");
    expect(stderr.join("")).not.toContain("/run/secrets/token");
  });

  test("refuses malformed remote-shell arguments before making a request", async () => {
    let requests = 0;
    for (const args of [
      ["controller", "printf", "ok"],
      ["controller", "--"],
      ["controller", "extra", "--", "true"],
    ]) {
      expect(
        await runSandboxHelper({
          argv0: "remote-shell",
          args,
          env: {
            MCP_GW_SHELL_URL: "https://gateway.example.com/shell/run",
            MCP_GW_RUN_TOKEN: "edge-placeholder",
          },
          fetch: () => {
            requests += 1;
            return Promise.resolve(new Response());
          },
          stdout: writer([]),
          stderr: writer([]),
        }),
      ).toBe(1);
    }
    expect(requests).toBe(0);
  });
});
