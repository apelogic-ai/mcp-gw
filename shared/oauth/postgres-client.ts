import { readFileSync } from "node:fs";

import type { Pool, PoolConfig } from "pg";

import type { SqlQueryClient } from "./sql-store";

export interface PgPoolLike {
  query(sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  connect(): Promise<PgClientLike>;
}

export interface PgClientLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(destroy?: boolean): void;
}

export interface TransactionalSqlQueryClient extends SqlQueryClient {
  transaction<T>(operation: (client: SqlQueryClient) => Promise<T>): Promise<T>;
}

export type ReadPostgresCaBundle = (path: string) => string;

export function createPostgresPoolConfig(
  connectionString: string,
  caBundlePath?: string,
  readCaBundle: ReadPostgresCaBundle = (path) => readFileSync(path, "utf8"),
): PoolConfig {
  if (!caBundlePath) {
    return { connectionString };
  }

  const ca = readCaBundle(caBundlePath);
  if (!ca.trim()) {
    throw new Error(`PostgreSQL CA bundle is empty: ${caBundlePath}`);
  }

  return {
    connectionString: removeConnectionStringTlsOptions(connectionString),
    ssl: {
      ca,
      rejectUnauthorized: true,
    },
  };
}

function removeConnectionStringTlsOptions(connectionString: string): string {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error(
      "TOKEN_STORE_DSN must be a PostgreSQL URL when POSTGRES_CA_BUNDLE_PATH is configured",
    );
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(
      "TOKEN_STORE_DSN must be a PostgreSQL URL when POSTGRES_CA_BUNDLE_PATH is configured",
    );
  }

  for (const parameter of [
    "ssl",
    "sslcert",
    "sslkey",
    "sslmode",
    "sslnegotiation",
    "sslrootcert",
    "uselibpqcompat",
  ]) {
    url.searchParams.delete(parameter);
  }

  return url.toString();
}

export function createPostgresQueryClient(pool: PgPoolLike | Pool): TransactionalSqlQueryClient {
  return {
    query: (sql, params) => pool.query(sql, params),
    sessionLock: async (key, operation) => {
      const connection = await pool.connect();
      let locked = false;
      let destroy = false;
      let outcome:
        | { ok: true; value: Awaited<ReturnType<typeof operation>> }
        | {
            ok: false;
            error: unknown;
          };
      try {
        await connection.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [key]);
        locked = true;
        // There is deliberately no BEGIN: an INSERT on this connection is
        // committed before control returns to the lifecycle for validation.
        outcome = {
          ok: true,
          value: await operation({ query: (sql, params) => connection.query(sql, params) }),
        };
      } catch (error) {
        // The server may have acquired the session lock before the client lost
        // the acknowledgement. Never return that connection to the pool.
        if (!locked) destroy = true;
        outcome = { ok: false, error };
      }
      try {
        if (locked) {
          const unlocked: unknown = await connection.query(
            "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
            [key],
          );
          const rows =
            typeof unlocked === "object" && unlocked !== null && "rows" in unlocked
              ? unlocked.rows
              : undefined;
          const row: unknown = Array.isArray(rows) ? rows[0] : undefined;
          if (
            typeof row !== "object" ||
            row === null ||
            !("pg_advisory_unlock" in row) ||
            row.pg_advisory_unlock !== true
          ) {
            throw new Error("OAuth connection issuance advisory lock was not released");
          }
        }
      } catch (error) {
        destroy = true;
        outcome = { ok: false, error };
      } finally {
        connection.release(destroy);
      }
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    },
    transaction: async (operation) => {
      const connection = await pool.connect();
      const transactionClient: SqlQueryClient = {
        query: (sql, params) => connection.query(sql, params),
      };
      try {
        await connection.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        const result = await operation(transactionClient);
        await connection.query("COMMIT");
        return result;
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      } finally {
        connection.release();
      }
    },
  };
}
