import { readFileSync } from "node:fs";

import type { Pool, PoolConfig } from "pg";

import type { SqlQueryClient } from "./sql-store";

export interface PgPoolLike {
  query(sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
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

export function createPostgresQueryClient(pool: PgPoolLike | Pool): SqlQueryClient {
  return {
    query: (sql, params) => pool.query(sql, params),
  };
}
