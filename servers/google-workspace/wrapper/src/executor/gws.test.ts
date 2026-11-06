import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { getGoogleWorkspaceTool } from "../catalog/google-workspace";
import { buildGwsArgs, executeGwsTool, GwsExecutionError } from "./gws";

const tempDirs: string[] = [];
const realGwsBinary = process.env.GWS_BINARY_PATH ?? "";
const testWithRealGws = realGwsBinary ? test : test.skip;

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

  test("preserves structured convenience-tool request bodies", () => {
    expect(
      buildGwsArgs(getGoogleWorkspaceTool("google_docs_batch_update"), {
        documentId: "doc-1",
        requests: [{ insertText: { text: "Hello", endOfSegmentLocation: {} } }],
      }),
    ).toEqual([
      "docs",
      "documents",
      "batchUpdate",
      "--params",
      JSON.stringify({ documentId: "doc-1" }),
      "--json",
      JSON.stringify({
        requests: [{ insertText: { text: "Hello", endOfSegmentLocation: {} } }],
      }),
      "--format",
      "json",
    ]);
  });

  test("stages inline upload bytes for gws and removes the temporary file", async () => {
    const binary = await fakeGws(`
node -e '
  const fs = require("node:fs");
  const argv = process.argv.slice(1);
  const uploadPath = argv[argv.indexOf("--upload") + 1];
  console.log(JSON.stringify({
    argv,
    uploadPath,
    uploadBase64: fs.readFileSync(uploadPath).toString("base64")
  }));
' "$@"
`);
    const contents = Buffer.from("remote MCP upload");

    const output = await executeGwsTool({
      tool: getGoogleWorkspaceTool("gws_drive_files_create"),
      args: {
        params: { fields: "id,name" },
        json: { name: "notes.txt" },
        uploadBase64: contents.toString("base64"),
        uploadContentType: "text/plain",
      },
      accessToken: "google-access-token",
      gwsBinary: binary,
    });
    const result = JSON.parse(String(output)) as unknown;

    expectRecord(result);
    expect(result.uploadBase64).toBe(contents.toString("base64"));
    expect(result.argv).toContain("--upload");
    expect(result.argv).toContain("--upload-content-type");
    expect(typeof result.uploadPath).toBe("string");
    expect(existsSync(String(result.uploadPath))).toBe(false);
  });

  testWithRealGws(
    "passes byte-identical inline upload content to the real gws dry-run",
    async () => {
      const captureDir = await mkdtemp(join(tmpdir(), "mcp-gw-real-gws-"));
      tempDirs.push(captureDir);
      const capturePath = join(captureDir, "upload.bin");
      const binary = await fakeGws(`
capture_upload() {
  set -- "$@"
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--upload" ]; then
      cp "$2" "$GWS_UPLOAD_CAPTURE"
      return
    fi
    shift
  done
  return 1
}
capture_upload "$@"
exec "$GWS_REAL_BINARY" "$@"
`);
      const contents = Buffer.from([0x00, 0x01, 0x7f, 0x80, 0xff, 0x0a, 0x41]);

      const result = await executeGwsTool({
        tool: getGoogleWorkspaceTool("gws_drive_files_create"),
        args: {
          params: { fields: "id,name" },
          json: { name: "bytes.bin" },
          uploadBase64: contents.toString("base64"),
          uploadContentType: "application/octet-stream",
          dryRun: true,
        },
        accessToken: "unused-dry-run-token",
        gwsBinary: binary,
        parentEnv: {
          ...process.env,
          GWS_REAL_BINARY: realGwsBinary,
          GWS_UPLOAD_CAPTURE: capturePath,
        },
      });

      expect(JSON.parse(String(result))).toMatchObject({
        dry_run: true,
        is_multipart_upload: true,
      });
      expect(await readFile(capturePath)).toEqual(contents);
    },
  );

  test("rejects ambiguous inline and server-path uploads", async () => {
    const binary = await fakeGws("printf '{}'");

    expect.assertions(1);
    try {
      await executeGwsTool({
        tool: getGoogleWorkspaceTool("gws_drive_files_create"),
        args: {
          upload: "/tmp/server-file",
          uploadBase64: Buffer.from("inline").toString("base64"),
        },
        accessToken: "google-access-token",
        gwsBinary: binary,
      });
    } catch (error) {
      expect((error as Error).message).toBe("upload and uploadBase64 cannot be used together");
    }
  });

  test("rejects malformed inline upload data before spawning gws", async () => {
    const binary = await fakeGws("exit 99");

    expect.assertions(1);
    try {
      await executeGwsTool({
        tool: getGoogleWorkspaceTool("gws_drive_files_create"),
        args: {
          uploadBase64: "not base64!",
        },
        accessToken: "google-access-token",
        gwsBinary: binary,
      });
    } catch (error) {
      expect((error as Error).message).toBe("uploadBase64 must contain valid base64 data");
    }
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
