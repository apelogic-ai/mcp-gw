import type { Pool } from "pg";

import type { SqlQueryClient } from "./sql-store";

export interface PgPoolLike {
  query(sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export function createPostgresQueryClient(pool: PgPoolLike | Pool): SqlQueryClient {
  return {
    query: (sql, params) => pool.query(sql, params),
  };
}
