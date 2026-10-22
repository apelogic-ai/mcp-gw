import { basename } from "node:path";

const HELPER_FAILURE_EXIT_CODE = 125;

interface ShimWriter {
  write(data: string): unknown;
}

export interface RunCliShimOptions {
  cli: string;
  args: readonly string[];
  endpoint: string;
  token: string;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  stdout?: ShimWriter;
  stderr?: ShimWriter;
}

export interface RunRemoteShellShimOptions {
  target: string;
  command: string;
  endpoint: string;
  token: string;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  stdout?: ShimWriter;
  stderr?: ShimWriter;
}

export interface RunSandboxHelperOptions {
  argv0: string;
  args: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  stdout?: ShimWriter;
  stderr?: ShimWriter;
}

export async function runCliShim(options: RunCliShimOptions): Promise<number> {
  return runRequest(
    {
      endpoint: options.endpoint,
      token: options.token,
      body: { cli: options.cli, args: options.args },
      fetch: options.fetch,
      stdout: options.stdout,
      stderr: options.stderr,
    },
    "CLI request failed\n",
  );
}

export async function runRemoteShellShim(options: RunRemoteShellShimOptions): Promise<number> {
  return runRequest(
    {
      endpoint: options.endpoint,
      token: options.token,
      body: { target: options.target, command: options.command },
      fetch: options.fetch,
      stdout: options.stdout,
      stderr: options.stderr,
    },
    "Remote shell request failed\n",
  );
}

export async function runSandboxHelper(options: RunSandboxHelperOptions): Promise<number> {
  const stderr = options.stderr ?? process.stderr;
  const fail = () => {
    stderr.write("Sandbox helper configuration failed\n");
    return HELPER_FAILURE_EXIT_CODE;
  };

  try {
    const command = basename(options.argv0);
    const token = required(options.env, "MCP_GW_RUN_TOKEN");
    if (command === "remote-shell") {
      if (options.args.length < 3 || options.args[1] !== "--") return fail();
      const target = options.args[0];
      const remoteCommand = options.args.slice(2).join(" ");
      if (!target?.trim() || !remoteCommand.trim()) return fail();
      return await runRemoteShellShim({
        target,
        command: remoteCommand,
        endpoint: endpoint(options.env, "MCP_GW_SHELL_URL"),
        token,
        fetch: options.fetch,
        stdout: options.stdout,
        stderr: options.stderr,
      });
    }
    if (!command || command === "mcp-gw-sandbox-helper") return fail();
    return await runCliShim({
      cli: command,
      args: options.args,
      endpoint: endpoint(options.env, "MCP_GW_CLI_URL"),
      token,
      fetch: options.fetch,
      stdout: options.stdout,
      stderr: options.stderr,
    });
  } catch {
    return fail();
  }
}

interface RunRequestOptions {
  endpoint: string;
  token: string;
  body: unknown;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  stdout?: ShimWriter;
  stderr?: ShimWriter;
}

async function runRequest(options: RunRequestOptions, failureMessage: string): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const fail = () => {
    stderr.write(failureMessage);
    return HELPER_FAILURE_EXIT_CODE;
  };

  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(options.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(options.body),
      redirect: "error",
    });
  } catch {
    return fail();
  }
  if (!response.ok || !response.body) return fail();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let exitCode: number | undefined;
  try {
    for (;;) {
      const result = (await reader.read()) as { done: boolean; value?: Uint8Array };
      buffered += result.value ? decoder.decode(result.value, { stream: true }) : decoder.decode();
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line) exitCode = consumeEvent(line, exitCode, stdout, stderr);
        newline = buffered.indexOf("\n");
      }
      if (result.done) break;
    }
  } catch {
    return fail();
  }
  if (buffered) {
    try {
      exitCode = consumeEvent(buffered, exitCode, stdout, stderr);
    } catch {
      return fail();
    }
  }
  return exitCode ?? fail();
}

function consumeEvent(
  line: string,
  exitCode: number | undefined,
  stdout: ShimWriter,
  stderr: ShimWriter,
): number | undefined {
  if (exitCode !== undefined) throw new Error("event followed exit");
  const event = JSON.parse(line) as unknown;
  if (!isRecord(event) || typeof event.type !== "string") throw new Error("invalid event");
  if (event.type === "stdout" || event.type === "stderr") {
    if (typeof event.data !== "string") throw new Error("invalid output event");
    (event.type === "stdout" ? stdout : stderr).write(event.data);
    return undefined;
  }
  if (
    event.type !== "exit" ||
    !Number.isSafeInteger(event.exit_code) ||
    (event.exit_code as number) < 0 ||
    (event.exit_code as number) > 255
  ) {
    throw new Error("invalid exit event");
  }
  return event.exit_code as number;
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function endpoint(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = required(env, name);
  const url = new URL(value);
  const loopback =
    url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  if (url.protocol !== "https:" && !loopback) throw new Error(`${name} must use HTTPS`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
