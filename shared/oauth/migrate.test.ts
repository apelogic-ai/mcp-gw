import { describe, expect, test } from "bun:test";

import {
  loadOAuthMigrations,
  runOAuthMigrations,
  type MigrationClient,
  type MigrationPool,
} from "./migrate";

class RecordingMigrationClient implements MigrationClient {
  readonly queries: { sql: string; params: unknown[] }[] = [];
  readonly applied = new Set<string>();
  released = false;
  failOn = "";

  query(sql: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    this.queries.push({ sql, params });

    if (this.failOn && sql.includes(this.failOn)) {
      return Promise.reject(new Error("migration failed"));
    }

    if (sql.includes("SELECT version FROM oauth_schema_migrations")) {
      return Promise.resolve({ rows: [...this.applied].map((version) => ({ version })) });
    }

    if (sql.includes("INSERT INTO oauth_schema_migrations")) {
      this.applied.add(String(params[0]));
    }

    return Promise.resolve({ rows: [] });
  }

  release(): void {
    this.released = true;
  }
}

class RecordingMigrationPool implements MigrationPool {
  readonly client = new RecordingMigrationClient();

  connect(): Promise<MigrationClient> {
    return Promise.resolve(this.client);
  }
}

describe("OAuth schema migrations", () => {
  test("loads ordered, versioned migrations from checked-in SQL", async () => {
    const migrations = await loadOAuthMigrations();

    expect(migrations.map(({ version }) => version)).toEqual(["001", "002"]);
    expect(migrations[0]?.sql).toContain("CREATE TABLE IF NOT EXISTS oauth_accounts");
    expect(migrations[0]?.sql).toContain("CREATE TABLE IF NOT EXISTS oauth_states");
    expect(migrations[1]?.sql).toContain("CREATE TABLE IF NOT EXISTS oauth_broker_transactions");
    expect(migrations[1]?.sql).toContain("CREATE TABLE IF NOT EXISTS oauth_dcr_clients");
  });

  test("serializes concurrent runners and applies each version once", async () => {
    const pool = new RecordingMigrationPool();
    const migrations = [{ version: "001", sql: "CREATE TABLE fixture_table (id TEXT);" }];

    await runOAuthMigrations(pool, migrations);
    await runOAuthMigrations(pool, migrations);

    const sql = pool.client.queries.map(({ sql: statement }) => statement);
    expect(sql.filter((statement) => statement === "BEGIN")).toHaveLength(2);
    expect(sql.filter((statement) => statement.includes("pg_advisory_xact_lock"))).toHaveLength(2);
    expect(
      sql.filter((statement) => statement.includes("CREATE TABLE fixture_table")),
    ).toHaveLength(1);
    expect(sql.filter((statement) => statement === "COMMIT")).toHaveLength(2);
    expect(pool.client.released).toBe(true);
  });

  test("rolls back and releases the connection when a migration fails", async () => {
    const pool = new RecordingMigrationPool();
    pool.client.failOn = "BROKEN MIGRATION";

    let migrationError: unknown;
    try {
      await runOAuthMigrations(pool, [{ version: "001", sql: "BROKEN MIGRATION" }]);
    } catch (error) {
      migrationError = error;
    }

    expect(migrationError).toBeInstanceOf(Error);
    expect((migrationError as Error).message).toBe("migration failed");
    expect(pool.client.queries.map(({ sql }) => sql)).toContain("ROLLBACK");
    expect(pool.client.released).toBe(true);
  });
});
