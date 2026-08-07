import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { Pool } from "pg";

const MIGRATION_FILE_PATTERN = /^(\d{3})_[a-z0-9_-]+\.sql$/;
const MIGRATION_LOCK_NAME = "mcp-gateway-oauth-schema";

export interface OAuthMigration {
  version: string;
  sql: string;
}

export interface MigrationClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
}

export interface MigrationPool {
  connect(): Promise<MigrationClient>;
}

export async function loadOAuthMigrations(
  directory = join(import.meta.dir, "migrations"),
): Promise<OAuthMigration[]> {
  const files = (await readdir(directory))
    .filter((file) => MIGRATION_FILE_PATTERN.test(file))
    .sort();

  return Promise.all(
    files.map(async (file) => {
      const match = MIGRATION_FILE_PATTERN.exec(file);
      if (!match?.[1]) {
        throw new Error(`Invalid OAuth migration file name: ${file}`);
      }

      return {
        version: match[1],
        sql: await Bun.file(join(directory, file)).text(),
      };
    }),
  );
}

export async function runOAuthMigrations(
  pool: MigrationPool,
  migrations: OAuthMigration[],
): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      MIGRATION_LOCK_NAME,
    ]);
    await client.query(`
CREATE TABLE IF NOT EXISTS oauth_schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
`);

    const result = await client.query("SELECT version FROM oauth_schema_migrations");
    const applied = new Set(result.rows.map((row) => String(row.version)));

    for (const migration of migrations) {
      if (applied.has(migration.version)) {
        continue;
      }

      await client.query(migration.sql);
      await client.query("INSERT INTO oauth_schema_migrations (version) VALUES ($1)", [
        migration.version,
      ]);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const connectionString = process.env.TOKEN_STORE_DSN;
  if (!connectionString) {
    throw new Error("Missing required env var: TOKEN_STORE_DSN");
  }

  const pool = new Pool({ connectionString });

  try {
    await runOAuthMigrations(
      {
        connect: async () => pool.connect(),
      },
      await loadOAuthMigrations(),
    );
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  await main();
}
