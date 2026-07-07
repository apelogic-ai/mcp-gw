import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { InMemoryAuditSink, JsonlAuditSink, digestArgs, redactValue } from "./audit";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("audit primitives", () => {
  test("redacts sensitive values recursively", () => {
    expect(
      redactValue({
        accessToken: "secret",
        nested: { refresh_token: "secret", keep: "value" },
      }),
    ).toEqual({
      accessToken: "[redacted]",
      nested: { refresh_token: "[redacted]", keep: "value" },
    });
  });

  test("digests args deterministically after redaction", () => {
    expect(digestArgs({ b: 2, a: "one", accessToken: "secret" })).toBe(
      digestArgs({ accessToken: "other-secret", a: "one", b: 2 }),
    );
  });

  test("captures events in memory", async () => {
    const sink = new InMemoryAuditSink();

    await sink.emit({
      ts: "2026-07-03T00:00:00.000Z",
      category: "tool_call",
      principal: "user@example.com",
      status: "allow",
    });

    expect(sink.events).toEqual([
      {
        ts: "2026-07-03T00:00:00.000Z",
        category: "tool_call",
        principal: "user@example.com",
        status: "allow",
      },
    ]);
  });

  test("writes JSONL events", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-gw-audit-"));
    tempDirs.push(dir);
    const path = join(dir, "audit.jsonl");
    const sink = new JsonlAuditSink(path);

    await sink.emit({
      ts: "2026-07-03T00:00:00.000Z",
      category: "oauth",
      principal: "user@example.com",
      event: "connect",
      status: "allow",
    });

    expect(await readFile(path, "utf8")).toBe(
      '{"ts":"2026-07-03T00:00:00.000Z","category":"oauth","principal":"user@example.com","event":"connect","status":"allow"}\n',
    );
  });
});
