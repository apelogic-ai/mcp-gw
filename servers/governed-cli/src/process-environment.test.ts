import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

import { sandboxHelperEnvironment } from "./process-environment";

describe("sandboxHelperEnvironment", () => {
  test("uses the runtime environment unchanged when it has entries", () => {
    let reads = 0;
    const runtime = { MCP_GW_RUN_TOKEN: "edge-placeholder", MCP_GW_CLI_URL: "https://gw/cli/run" };

    const env = sandboxHelperEnvironment(runtime, () => {
      reads += 1;
      return new TextEncoder().encode("MCP_GW_RUN_TOKEN=other\0");
    });

    expect(env).toBe(runtime);
    expect(reads).toBe(0);
  });

  test("loads the process's own environ when the runtime environment is empty", () => {
    // Bun standalone executables can start with an empty process.env under some process
    // supervisors (seccomp and no-new-privileges), although the kernel passed the environment.
    const environ = new TextEncoder().encode(
      "MCP_GW_RUN_TOKEN=edge-placeholder\0MCP_GW_CLI_URL=https://gw/cli/run?a=b=c\0\0",
    );

    const env = sandboxHelperEnvironment({}, () => environ);

    expect(env).toEqual({
      MCP_GW_RUN_TOKEN: "edge-placeholder",
      MCP_GW_CLI_URL: "https://gw/cli/run?a=b=c",
    });
  });

  test("ignores entries without a name or separator", () => {
    const environ = new TextEncoder().encode("=orphan\0NO_SEPARATOR\0EMPTY=\0KEPT=1\0");

    expect(sandboxHelperEnvironment({}, () => environ)).toEqual({ EMPTY: "", KEPT: "1" });
  });

  test("stays empty, so configuration still fails closed, when environ cannot be read", () => {
    const env = sandboxHelperEnvironment({}, () => {
      throw new Error("EACCES");
    });

    expect(env).toEqual({});
  });
});

test("the helper entry point reads its environment through the fallback", async () => {
  const source = await readFile(new URL("./sandbox-helper.ts", import.meta.url), "utf8");

  expect(source).toContain("sandboxHelperEnvironment(process.env)");
  expect(source).not.toMatch(/env:\s*process\.env\b/u);
});
