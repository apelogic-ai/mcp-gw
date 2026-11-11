import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
      ).toBe(125);
      expect(stdout).toEqual(response.status === 403 ? [] : ["missing exit"]);
      expect(stderr.join("")).toBe("CLI request failed\n");
      expect(stderr.join("")).not.toContain("provider-secret");
    }
  });

  test("selects governed CLI and remote shell by invocation name", async () => {
    const requests: { url: string; authorization: string | null; body: unknown }[] = [];
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

  test("selects governed CLI and remote shell with a leading operation", async () => {
    const requests: { url: string; body: unknown }[] = [];
    const fetch = (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
      });
      return Promise.resolve(new Response('{"type":"exit","exit_code":0}\n'));
    };
    const env = {
      MCP_GW_CLI_URL: "https://gateway.example.com/cli/run",
      MCP_GW_SHELL_URL: "https://gateway.example.com/shell/run",
      MCP_GW_RUN_TOKEN: "edge-placeholder",
    };

    expect(
      await runSandboxHelper({
        argv0: "/usr/local/bin/mcp-gw-sandbox-helper",
        args: ["--operation", "kubectl", "get", "pods"],
        env,
        fetch,
        stdout: writer([]),
        stderr: writer([]),
      }),
    ).toBe(0);
    expect(
      await runSandboxHelper({
        argv0: "/sandbox/canonical-executable",
        args: ["--operation", "remote-shell", "controller", "--", "uname", "-a"],
        env,
        fetch,
        stdout: writer([]),
        stderr: writer([]),
      }),
    ).toBe(0);

    expect(requests).toEqual([
      {
        url: "https://gateway.example.com/cli/run",
        body: { cli: "kubectl", args: ["get", "pods"] },
      },
      {
        url: "https://gateway.example.com/shell/run",
        body: { target: "controller", command: "uname -a" },
      },
    ]);
  });

  test("refuses invalid operation selectors before making a request", async () => {
    const stderr: string[] = [];
    let requests = 0;
    const env = {
      MCP_GW_CLI_URL: "https://gateway.example.com/cli/run",
      MCP_GW_SHELL_URL: "https://gateway.example.com/shell/run",
      MCP_GW_RUN_TOKEN: "edge-placeholder",
    };

    for (const [argv0, args] of [
      ["mcp-gw-sandbox-helper", ["--operation", "unknown", "get", "pods"]],
      ["mcp-gw-sandbox-helper", ["--operation"]],
      ["kubectl", ["get", "pods", "--operation", "remote-shell"]],
      ["kubectl", ["--operation", "remote-shell", "controller", "--", "true"]],
    ] as const) {
      expect(
        await runSandboxHelper({
          argv0,
          args,
          env,
          fetch: () => {
            requests += 1;
            return Promise.resolve(new Response());
          },
          stdout: writer([]),
          stderr: writer(stderr),
        }),
      ).toBe(125);
    }

    expect(requests).toBe(0);
    expect(stderr).toEqual([
      "Sandbox helper configuration failed: invalid operation\n",
      "Sandbox helper configuration failed: invalid operation\n",
      "Sandbox helper configuration failed: invalid operation\n",
      "Sandbox helper configuration failed: invalid operation\n",
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
      ).toBe(125);
    }

    expect(requests).toBe(0);
    expect(stderr).toEqual([
      "Sandbox helper configuration failed: missing run token\n",
      "Sandbox helper configuration failed: MCP_GW_CLI_URL must use HTTPS\n",
      "Sandbox helper configuration failed: missing run token\n",
    ]);
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
      ).toBe(125);
    }
    expect(requests).toBe(0);
  });

  test("refuses redirects without replaying the command request", async () => {
    let redirectedRequests = 0;
    const destination = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        redirectedRequests += 1;
        return new Response('{"type":"exit","exit_code":0}\n');
      },
    });
    const destinationPort = destination.port;
    if (destinationPort === undefined) throw new Error("Destination server did not bind");
    const origin = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.redirect(`http://127.0.0.1:${String(destinationPort)}/captured`, 307),
    });
    const originPort = origin.port;
    if (originPort === undefined) throw new Error("Origin server did not bind");

    try {
      expect(
        await runCliShim({
          cli: "kubectl",
          args: ["get", "pods"],
          endpoint: `http://127.0.0.1:${String(originPort)}/cli/run`,
          token: "edge-placeholder",
          stdout: writer([]),
          stderr: writer([]),
        }),
      ).toBe(125);
      expect(redirectedRequests).toBe(0);
    } finally {
      await Promise.all([origin.stop(true), destination.stop(true)]);
    }
  });
});

describe("explicit helper configuration options", () => {
  // Under some process supervisors the helper starts with an empty environment, so wrappers pass
  // the run-token placeholder and the command route as leading options instead.
  const requests: { url: string; authorization: string | null; body: unknown }[] = [];
  const fetch = (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      authorization: new Headers(init?.headers).get("authorization"),
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
    });
    return Promise.resolve(new Response('{"type":"exit","exit_code":0}\n'));
  };

  test("leading options configure kubectl and remote-shell with an empty environment", async () => {
    requests.length = 0;
    expect(
      await runSandboxHelper({
        argv0: "/usr/local/bin/mcp-gw-sandbox-helper",
        args: [
          "--run-token",
          "edge-placeholder",
          "--cli-url",
          "https://gateway.example.com/cli/run",
          "--operation",
          "kubectl",
          "get",
          "pods",
        ],
        env: {},
        fetch,
        stdout: writer([]),
        stderr: writer([]),
      }),
    ).toBe(0);
    expect(
      await runSandboxHelper({
        argv0: "/usr/local/bin/mcp-gw-sandbox-helper",
        args: [
          "--shell-url",
          "https://gateway.example.com/shell/run",
          "--run-token",
          "edge-placeholder",
          "--operation",
          "remote-shell",
          "controller",
          "--",
          "uname",
          "-a",
        ],
        env: {},
        fetch,
        stdout: writer([]),
        stderr: writer([]),
      }),
    ).toBe(0);

    expect(requests).toEqual([
      {
        url: "https://gateway.example.com/cli/run",
        authorization: "Bearer edge-placeholder",
        body: { cli: "kubectl", args: ["get", "pods"] },
      },
      {
        url: "https://gateway.example.com/shell/run",
        authorization: "Bearer edge-placeholder",
        body: { target: "controller", command: "uname -a" },
      },
    ]);
  });

  test("leading options take precedence over the environment", async () => {
    requests.length = 0;
    expect(
      await runSandboxHelper({
        argv0: "mcp-gw-sandbox-helper",
        args: [
          "--run-token",
          "option-placeholder",
          "--cli-url",
          "https://option.example.com/cli/run",
          "--operation",
          "kubectl",
          "version",
        ],
        env: {
          MCP_GW_RUN_TOKEN: "environment-placeholder",
          MCP_GW_CLI_URL: "https://environment.example.com/cli/run",
        },
        fetch,
        stdout: writer([]),
        stderr: writer([]),
      }),
    ).toBe(0);
    expect(requests).toEqual([
      {
        url: "https://option.example.com/cli/run",
        authorization: "Bearer option-placeholder",
        body: { cli: "kubectl", args: ["version"] },
      },
    ]);
  });

  test("kubectl arguments after the operation are never read as helper options", async () => {
    requests.length = 0;
    expect(
      await runSandboxHelper({
        argv0: "mcp-gw-sandbox-helper",
        args: [
          "--run-token",
          "p",
          "--cli-url",
          "https://gw.example.com/cli/run",
          "--operation",
          "kubectl",
          "--cli-url",
          "x",
        ],
        env: {},
        fetch,
        stdout: writer([]),
        stderr: writer([]),
      }),
    ).toBe(0);
    expect(requests).toEqual([
      {
        url: "https://gw.example.com/cli/run",
        authorization: "Bearer p",
        body: { cli: "kubectl", args: ["--cli-url", "x"] },
      },
    ]);
  });

  test("refuses unknown, duplicate, empty or misplaced options before making a request", async () => {
    requests.length = 0;
    const stderr: string[] = [];
    for (const [argv0, args] of [
      ["mcp-gw-sandbox-helper", ["--token", "p", "--operation", "kubectl", "get", "pods"]],
      [
        "mcp-gw-sandbox-helper",
        ["--run-token", "p", "--run-token", "q", "--operation", "kubectl", "get"],
      ],
      ["mcp-gw-sandbox-helper", ["--run-token"]],
      ["mcp-gw-sandbox-helper", ["--run-token", "--operation", "kubectl", "get"]],
      ["kubectl", ["--run-token", "p", "get", "pods"]],
    ] as const) {
      expect(
        await runSandboxHelper({
          argv0,
          args,
          env: {
            MCP_GW_CLI_URL: "https://gw.example.com/cli/run",
            MCP_GW_RUN_TOKEN: "env-placeholder",
          },
          fetch,
          stdout: writer([]),
          stderr: writer(stderr),
        }),
      ).toBe(125);
    }
    expect(requests).toEqual([]);
    expect(stderr).toEqual([
      "Sandbox helper configuration failed: invalid operation\n",
      "Sandbox helper configuration failed: invalid helper option\n",
      "Sandbox helper configuration failed: invalid helper option\n",
      "Sandbox helper configuration failed: invalid helper option\n",
      "Sandbox helper configuration failed: invalid helper option\n",
    ]);
  });

  test("validates option values like environment values and never prints them", async () => {
    requests.length = 0;
    const stderr: string[] = [];
    for (const args of [
      [
        "--run-token",
        " ",
        "--cli-url",
        "https://gw.example.com/cli/run",
        "--operation",
        "kubectl",
        "get",
      ],
      [
        "--run-token",
        "secret-looking",
        "--cli-url",
        "http://192.0.2.1/cli/run",
        "--operation",
        "kubectl",
        "get",
      ],
      ["--run-token", "secret-looking", "--cli-url", "not a url", "--operation", "kubectl", "get"],
      ["--run-token", "secret-looking", "--operation", "kubectl", "get"],
      [
        "--run-token",
        "secret-looking",
        "--shell-url",
        "http://192.0.2.1/shell/run",
        "--operation",
        "remote-shell",
        "c",
        "--",
        "true",
      ],
    ]) {
      expect(
        await runSandboxHelper({
          argv0: "mcp-gw-sandbox-helper",
          args,
          env: {},
          fetch,
          stdout: writer([]),
          stderr: writer(stderr),
        }),
      ).toBe(125);
    }
    expect(requests).toEqual([]);
    expect(stderr).toEqual([
      "Sandbox helper configuration failed: missing run token\n",
      "Sandbox helper configuration failed: MCP_GW_CLI_URL must use HTTPS\n",
      "Sandbox helper configuration failed: MCP_GW_CLI_URL is not a valid URL\n",
      "Sandbox helper configuration failed: missing MCP_GW_CLI_URL\n",
      "Sandbox helper configuration failed: MCP_GW_SHELL_URL must use HTTPS\n",
    ]);
    expect(stderr.join("")).not.toContain("secret-looking");
    expect(stderr.join("")).not.toContain("192.0.2.1");
  });
});

describe("explicit egress options", () => {
  // The same supervisors also hide the sandbox's egress proxy and its TLS-terminating CA from the
  // helper, so a direct connection is refused. Wrappers pass both as leading options.
  const pem = "-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n";
  const seen: { url: string; proxy: unknown; tls: unknown }[] = [];
  const fetch = (input: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      proxy: (init as { proxy?: unknown } | undefined)?.proxy,
      tls: (init as { tls?: unknown } | undefined)?.tls,
    });
    return Promise.resolve(new Response('{"type":"exit","exit_code":0}\n'));
  };
  async function caFile(contents: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "mcp-gw-helper-ca-"));
    const path = join(directory, "ca-bundle.pem");
    await writeFile(path, contents);
    return path;
  }
  function helper(args: readonly string[], stderr: string[] = []) {
    return runSandboxHelper({
      argv0: "mcp-gw-sandbox-helper",
      args,
      env: {},
      fetch,
      stdout: writer([]),
      stderr: writer(stderr),
    });
  }

  test("--proxy and --ca-file reach the request for kubectl and remote-shell", async () => {
    seen.length = 0;
    const ca = await caFile(pem);
    const egress = ["--proxy", "http://127.0.0.1:3128", "--ca-file", ca];
    expect(
      await helper([
        ...egress,
        "--run-token",
        "p",
        "--cli-url",
        "https://gw.example.com/cli/run",
        "--operation",
        "kubectl",
        "get",
        "pods",
      ]),
    ).toBe(0);
    expect(
      await helper([
        "--run-token",
        "p",
        "--shell-url",
        "https://gw.example.com/shell/run",
        ...egress,
        "--operation",
        "remote-shell",
        "c",
        "--",
        "true",
      ]),
    ).toBe(0);
    expect(seen).toEqual([
      { url: "https://gw.example.com/cli/run", proxy: "http://127.0.0.1:3128", tls: { ca: pem } },
      { url: "https://gw.example.com/shell/run", proxy: "http://127.0.0.1:3128", tls: { ca: pem } },
    ]);
  });

  test("without egress options the request is unchanged", async () => {
    seen.length = 0;
    expect(
      await helper([
        "--run-token",
        "p",
        "--cli-url",
        "https://gw.example.com/cli/run",
        "--operation",
        "kubectl",
        "get",
      ]),
    ).toBe(0);
    expect(seen).toEqual([
      { url: "https://gw.example.com/cli/run", proxy: undefined, tls: undefined },
    ]);
  });

  test("a loopback endpoint never uses the proxy", async () => {
    seen.length = 0;
    expect(
      await helper([
        "--proxy",
        "http://127.0.0.1:3128",
        "--run-token",
        "p",
        "--cli-url",
        "http://127.0.0.1:9/cli/run",
        "--operation",
        "kubectl",
        "get",
      ]),
    ).toBe(0);
    expect(seen).toEqual([{ url: "http://127.0.0.1:9/cli/run", proxy: undefined, tls: undefined }]);
  });

  test("egress options after the operation stay command arguments", async () => {
    seen.length = 0;
    expect(
      await helper([
        "--run-token",
        "p",
        "--cli-url",
        "https://gw.example.com/cli/run",
        "--operation",
        "kubectl",
        "--proxy",
        "http://127.0.0.1:3128",
      ]),
    ).toBe(0);
    expect(seen).toEqual([
      { url: "https://gw.example.com/cli/run", proxy: undefined, tls: undefined },
    ]);
  });

  test("refuses bad egress options before any request and never prints their values", async () => {
    seen.length = 0;
    const stderr: string[] = [];
    const ca = await caFile(pem);
    const notPem = await caFile("secret-looking contents\n");
    const route = ["--run-token", "p", "--cli-url", "https://gw.example.com/cli/run"];
    for (const egress of [
      ["--proxy", " "],
      ["--proxy", "not a url"],
      ["--proxy", "socks5://secret-looking@127.0.0.1:1080"],
      ["--proxy", "http://127.0.0.1:3128", "--proxy", "http://127.0.0.1:3129"],
      ["--ca-file", ca, "--ca-file", ca],
      ["--ca-file", "/nonexistent/secret-looking.pem"],
      ["--ca-file", notPem],
      ["--ca-file", " "],
    ]) {
      expect(await helper([...egress, ...route, "--operation", "kubectl", "get"], stderr)).toBe(
        125,
      );
    }
    expect(seen).toEqual([]);
    expect(stderr).toEqual([
      "Sandbox helper configuration failed: invalid proxy URL\n",
      "Sandbox helper configuration failed: invalid proxy URL\n",
      "Sandbox helper configuration failed: invalid proxy URL\n",
      "Sandbox helper configuration failed: invalid helper option\n",
      "Sandbox helper configuration failed: invalid helper option\n",
      "Sandbox helper configuration failed: unreadable CA file\n",
      "Sandbox helper configuration failed: invalid CA file\n",
      "Sandbox helper configuration failed: unreadable CA file\n",
    ]);
    expect(stderr.join("")).not.toContain("secret-looking");
  });
});
