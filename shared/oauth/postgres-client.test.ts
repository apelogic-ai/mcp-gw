import { describe, expect, test } from "bun:test";

import { createPostgresQueryClient, type PgPoolLike } from "./postgres-client";

describe("Postgres OAuth query client", () => {
  test("delegates SQL and params to a pg-compatible pool", async () => {
    const pool = new RecordingPool([{ ok: true }]);
    const client = createPostgresQueryClient(pool);

    const result = await client.query("SELECT $1::text", ["value"]);

    expect(result.rows).toEqual([{ ok: true }]);
    expect(pool.calls).toEqual([{ sql: "SELECT $1::text", params: ["value"] }]);
  });
});

class RecordingPool implements PgPoolLike {
  readonly calls: { sql: string; params: unknown[] }[] = [];

  constructor(private readonly rows: Record<string, unknown>[]) {}

  query(sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    this.calls.push({ sql, params });
    return Promise.resolve({ rows: this.rows });
  }
}
