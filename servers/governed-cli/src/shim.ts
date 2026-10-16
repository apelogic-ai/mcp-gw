import { basename } from "node:path";

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

export async function runCliShim(options: RunCliShimOptions): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const fail = () => {
    stderr.write("CLI request failed\n");
    return 1;
  };

  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(options.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ cli: options.cli, args: options.args }),
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

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.main) {
  process.exitCode = await runCliShim({
    cli: basename(process.argv0),
    args: process.argv.slice(2),
    endpoint: requiredEnv("MCP_GW_CLI_URL"),
    token: requiredEnv("MCP_GW_RUN_TOKEN"),
  });
}
