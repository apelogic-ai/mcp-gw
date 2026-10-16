import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeCli, type CliRunnerConfig } from "./executor";

let directory: string;
let fakeCli: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "governed-cli-"));
  fakeCli = join(directory, "fake-cli.ts");
  await writeFile(
    fakeCli,
    `const args = Bun.argv.slice(2);
if (args[0] === "large") console.log("x".repeat(100));
else if (args[0] === "sleep") { process.on("SIGTERM", () => {}); await Bun.sleep(10_000); }
else if (args[0] === "split-secret") { process.stdout.write("runner-"); await Bun.sleep(10); process.stdout.write("secret"); }
else console.log(JSON.stringify({ args, token: process.env.RUNNER_TOKEN, config: process.env.RUNNER_CONFIG, inherited: process.env.UNAPPROVED_ENV }));
console.error(process.env.RUNNER_TOKEN ?? "");
`,
  );
  await chmod(fakeCli, 0o700);
});

afterAll(async () => rm(directory, { recursive: true, force: true }));

function config(overrides: Partial<CliRunnerConfig> = {}): CliRunnerConfig {
  return {
    binary: process.execPath,
    fixedArgs: [fakeCli],
    env: {
      PATH: process.env.PATH ?? "",
      RUNNER_CONFIG: "/runner/config",
      RUNNER_TOKEN: "runner-secret",
    },
    cwd: directory,
    redactValues: ["/runner/config", "runner-secret"],
    defaultTimeoutSeconds: 2,
    maxTimeoutSeconds: 3,
    maxOutputBytes: 1024,
    ...overrides,
  };
}

describe("CLI execution", () => {
  test("passes shell metacharacters literally without invoking a shell", async () => {
    const marker = join(directory, "marker");
    const metacharacters = [";", "|", `$(touch ${marker})`];
    const result = await executeCli(config(), ["inspect", ...metacharacters], "read");
    const output = JSON.parse(result.stdout) as { args: string[] };
    expect(output.args).toEqual(["inspect", ...metacharacters]);
    expect(access(marker)).rejects.toThrow();
  });

  test("uses only fixed runner environment and redacts credential values", async () => {
    process.env.UNAPPROVED_ENV = "must-not-be-inherited";
    try {
      const result = await executeCli(config(), ["RUNNER_TOKEN=attacker"], "read");
      expect(result.stdout).not.toContain("runner-secret");
      expect(result.stdout).not.toContain("/runner/config");
      expect(result.stdout).not.toContain("must-not-be-inherited");
      expect(result.stdout).toContain("RUNNER_TOKEN=attacker");
      expect(result.stderr).toBe("[redacted]\n");
    } finally {
      delete process.env.UNAPPROVED_ENV;
    }
  });

  test("bounds output and marks truncation", async () => {
    const chunks: string[] = [];
    const result = await executeCli(
      config({ maxOutputBytes: 16, redactValues: [] }),
      ["large"],
      "read",
      undefined,
      { onOutput: (stream, data) => stream === "stdout" && chunks.push(data) },
    );
    expect(Buffer.byteLength(result.stdout)).toBe(16);
    expect(chunks.join("")).toBe(result.stdout);
    expect(result.stdout_truncated).toBe(true);
  });

  test("redacts streamed credentials split across child chunks", async () => {
    const chunks: string[] = [];
    const result = await executeCli(config(), ["split-secret"], "read", undefined, {
      onOutput: (stream, data) => {
        if (stream === "stdout") chunks.push(data);
      },
    });

    expect(chunks.join("")).toBe("[redacted]");
    expect(result.stdout).toBe("[redacted]");
  });

  test("bounds requested timeouts", async () => {
    expect(executeCli(config(), ["inspect"], "read", 4)).rejects.toThrow(
      "outside the allowed range",
    );
    const result = await executeCli(config({ defaultTimeoutSeconds: 1 }), ["sleep"], "read");
    expect(result.exit_code).toBe(124);
  });
});
