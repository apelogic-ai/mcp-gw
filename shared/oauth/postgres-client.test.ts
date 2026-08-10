import { describe, expect, test } from "bun:test";
import { Client } from "pg";

import {
  createPostgresPoolConfig,
  createPostgresQueryClient,
  type PgPoolLike,
} from "./postgres-client";

describe("Postgres OAuth query client", () => {
  test("delegates SQL and params to a pg-compatible pool", async () => {
    const pool = new RecordingPool([{ ok: true }]);
    const client = createPostgresQueryClient(pool);

    const result = await client.query("SELECT $1::text", ["value"]);

    expect(result.rows).toEqual([{ ok: true }]);
    expect(pool.calls).toEqual([{ sql: "SELECT $1::text", params: ["value"] }]);
  });

  test("builds a verified TLS pool config from an operator-mounted CA bundle", () => {
    const config = createPostgresPoolConfig(
      "postgres://mcp:mcp@token-store:5432/mcp?sslmode=require",
      "/var/run/secrets/postgresql/ca.crt",
      (path) => {
        expect(path).toBe("/var/run/secrets/postgresql/ca.crt");
        return "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n";
      },
    );

    expect(config).toEqual({
      connectionString: "postgres://mcp:mcp@token-store:5432/mcp",
      ssl: {
        ca: "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n",
        rejectUnauthorized: true,
      },
    });
  });

  test("fails closed when a configured CA bundle is empty", () => {
    expect(() =>
      createPostgresPoolConfig(
        "postgres://mcp:mcp@token-store:5432/mcp?sslmode=require",
        "/var/run/secrets/postgresql/ca.crt",
        () => "  \n",
      ),
    ).toThrow("PostgreSQL CA bundle is empty");
  });

  test("prevents DSN TLS options from overriding the verified CA configuration", () => {
    const config = createPostgresPoolConfig(
      "postgres://mcp:mcp@token-store:5432/mcp?application_name=gateway&sslmode=no-verify&sslrootcert=%2Ftmp%2Fwrong.pem",
      "/var/run/secrets/postgresql/ca.crt",
      () => "trusted-ca",
    );

    expect(config.connectionString).toBe(
      "postgres://mcp:mcp@token-store:5432/mcp?application_name=gateway",
    );
    expect(config.ssl).toEqual({ ca: "trusted-ca", rejectUnauthorized: true });

    const client = new Client(config);
    expect((client as unknown as { ssl: unknown }).ssl).toEqual({
      ca: "trusted-ca",
      rejectUnauthorized: true,
    });
  });

  test("fails closed on a non-URL DSN when an explicit CA bundle is configured", () => {
    expect(() =>
      createPostgresPoolConfig("host=token-store dbname=mcp", "/ca.crt", () => "trusted-ca"),
    ).toThrow("TOKEN_STORE_DSN must be a PostgreSQL URL");
  });

  test("fails closed on a non-PostgreSQL URL when an explicit CA bundle is configured", () => {
    expect(() =>
      createPostgresPoolConfig("https://token-store.example.com/mcp", "/ca.crt", () => "ca"),
    ).toThrow("TOKEN_STORE_DSN must be a PostgreSQL URL");
  });

  test("keeps the existing connection behavior when no CA bundle is configured", () => {
    expect(createPostgresPoolConfig("postgres://mcp:mcp@token-store:5432/mcp")).toEqual({
      connectionString: "postgres://mcp:mcp@token-store:5432/mcp",
    });
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
