import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { getGoogleWorkspaceTool } from "../catalog/google-workspace";
import { buildGwsArgs, executeGwsTool, GwsExecutionError } from "./gws";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function fakeGws(script: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mcp-gw-gws-"));
  tempDirs.push(dir);

  const path = join(dir, "gws");
  await writeFile(path, `#!/usr/bin/env bash\nset -euo pipefail\n${script}\n`, "utf8");
  await chmod(path, 0o755);
  return path;
}

function expectRecord(value: unknown): asserts value is Record<string, unknown> {
  expect(typeof value).toBe("object");
  expect(value).not.toBeNull();
}

describe("gws executor", () => {
  test("injects only the per-user Google access token into the child process", async () => {
    const binary = await fakeGws(`
node -e 'console.log(JSON.stringify({
  argv: process.argv.slice(1),
  token: process.env.GOOGLE_WORKSPACE_CLI_TOKEN,
  authorization: process.env.AUTHORIZATION ?? null,
  home: process.env.HOME,
  config: process.env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR
}))' "$@"
`);

    const result = await executeGwsTool({
      tool: getGoogleWorkspaceTool("google_drive_files_list"),
      args: { q: "name contains 'roadmap'", pageSize: 10 },
      accessToken: "google-access-token",
      gwsBinary: binary,
      parentEnv: {
        AUTHORIZATION: "Bearer hop1-token",
        GOOGLE_WORKSPACE_CLI_TOKEN: "stale-token",
      },
    });

    expectRecord(result);
    expect(result).toMatchObject({
      token: "google-access-token",
      authorization: null,
    });
    expect(result.argv).toEqual([
      "drive",
      "files",
      "list",
      "--params",
      JSON.stringify({
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
        q: "name contains 'roadmap'",
        pageSize: 10,
      }),
      "--format",
      "json",
    ]);
    expect(String(result.home)).toContain("gws-home-");
    expect(String(result.config)).toContain("gws-config-");
  });

  test("normalizes invalid JSON output", async () => {
    const binary = await fakeGws("printf 'not-json'");

    expect.assertions(2);
    try {
      await executeGwsTool({
        tool: getGoogleWorkspaceTool("google_docs_get"),
        args: { documentId: "doc-1" },
        accessToken: "token",
        gwsBinary: binary,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(GwsExecutionError);
      expect((error as GwsExecutionError).code).toBe("invalid_json");
    }
  });

  test("redacts access tokens from process errors", async () => {
    const binary = await fakeGws(`
echo token=$GOOGLE_WORKSPACE_CLI_TOKEN >&2
echo stdout-token=$GOOGLE_WORKSPACE_CLI_TOKEN
exit 7
`);

    expect.assertions(5);
    try {
      await executeGwsTool({
        tool: getGoogleWorkspaceTool("google_docs_get"),
        args: { documentId: "doc-1" },
        accessToken: "sensitive-token",
        gwsBinary: binary,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(GwsExecutionError);
      expect((error as Error).message).toContain("token=[redacted]");
      expect((error as Error).message).not.toContain("sensitive-token");
      expect((error as GwsExecutionError).stderr).toContain("token=[redacted]");
      expect((error as GwsExecutionError).stdout).toContain("stdout-token=[redacted]");
    }
  });

  test("passes full gws argv through unchanged for the generic tool", () => {
    expect(
      buildGwsArgs(getGoogleWorkspaceTool("google_workspace_gws"), {
        argv: ["gmail", "+send", "--to", "alice@example.com", "--subject", "Hello", "--body", "Hi"],
        scopes: ["https://www.googleapis.com/auth/gmail.modify"],
      }),
    ).toEqual([
      "gmail",
      "+send",
      "--to",
      "alice@example.com",
      "--subject",
      "Hello",
      "--body",
      "Hi",
    ]);
  });

  test("returns raw stdout for generic gws calls", async () => {
    const binary = await fakeGws(`
printf '{"page":1}\\n{"page":2}\\n'
`);

    const result = await executeGwsTool({
      tool: getGoogleWorkspaceTool("google_workspace_gws"),
      args: {
        argv: ["drive", "files", "list", "--page-all"],
        scopes: ["https://www.googleapis.com/auth/drive"],
      },
      accessToken: "google-access-token",
      gwsBinary: binary,
    });

    expect(result).toBe('{"page":1}\n{"page":2}\n');
  });

  test("builds gws argv for generated Discovery tools", () => {
    expect(
      buildGwsArgs(getGoogleWorkspaceTool("gws_slides_presentations_batch_update"), {
        params: { presentationId: "deck-1" },
        json: { requests: [] },
        pageAll: true,
        pageLimit: 2,
        extraArgs: ["--format", "json"],
      }),
    ).toEqual([
      "slides",
      "presentations",
      "batchUpdate",
      "--params",
      JSON.stringify({ presentationId: "deck-1" }),
      "--json",
      JSON.stringify({ requests: [] }),
      "--page-limit",
      "2",
      "--page-all",
      "--format",
      "json",
    ]);
  });

  test("builds gws argv for generated helper tools", () => {
    expect(
      buildGwsArgs(getGoogleWorkspaceTool("gws_gmail_send"), {
        args: ["--to", "alice@example.com", "--subject", "Hello", "--body", "Hi"],
      }),
    ).toEqual([
      "gmail",
      "+send",
      "--to",
      "alice@example.com",
      "--subject",
      "Hello",
      "--body",
      "Hi",
    ]);
  });
});
