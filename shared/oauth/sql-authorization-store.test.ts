import { describe, expect, test } from "bun:test";

import type {
  AuthorizationTransactionRecord,
  BrokerAuthorizationCodeRecord,
} from "./authorization-broker";
import type { StoredDynamicDcrClient } from "./dcr";
import { SqlAuthorizationBrokerStore, SqlDcrRegistrationStore } from "./sql-authorization-store";
import type { SqlQueryClient } from "./sql-store";

const transaction: AuthorizationTransactionRecord = {
  stateHash: "hashed-broker-state",
  clientId: "client-id",
  redirectUri: "https://client.example/callback",
  resource: "https://mcp.example.com/mcp",
  scopes: ["mcp"],
  clientState: "opaque-client-state",
  codeChallenge: "A".repeat(43),
  googleNonce: "google-nonce",
  googleCodeVerifier: "v".repeat(64),
  expiresAt: Date.parse("2026-08-19T23:05:00.000Z"),
};

const authorizationCode: BrokerAuthorizationCodeRecord = {
  codeHash: "hashed-broker-code",
  clientId: transaction.clientId,
  redirectUri: transaction.redirectUri,
  resource: transaction.resource,
  scopes: transaction.scopes,
  codeChallenge: transaction.codeChallenge,
  identity: {
    issuer: "https://accounts.google.com",
    subject: "google-subject",
    email: "person@example.com",
    emailVerified: true,
  },
  expiresAt: Date.parse("2026-08-19T23:03:00.000Z"),
};

describe("SQL authorization broker store", () => {
  test("persists only hashed broker state and atomically consumes a live transaction", async () => {
    const client = new QueueSqlClient();
    const store = new SqlAuthorizationBrokerStore(client);

    await store.saveTransaction(transaction);
    expect(client.calls[0]?.sql).toContain("INSERT INTO oauth_broker_transactions");
    expect(client.calls[0]?.params[0]).toBe("hashed-broker-state");
    expect(client.calls[0]?.params).not.toContain("raw-broker-state");

    client.queue.push([
      {
        state_hash: transaction.stateHash,
        client_id: transaction.clientId,
        redirect_uri: transaction.redirectUri,
        resource: transaction.resource,
        scopes: transaction.scopes,
        client_state: transaction.clientState,
        code_challenge: transaction.codeChallenge,
        google_nonce: transaction.googleNonce,
        google_code_verifier: transaction.googleCodeVerifier,
        expires_at: new Date(transaction.expiresAt),
      },
    ]);
    expect(await store.consumeTransaction(transaction.stateHash)).toEqual(transaction);
    expect(client.calls[1]?.sql).toContain("DELETE FROM oauth_broker_transactions");
    expect(client.calls[1]?.sql).toContain("expires_at > NOW()");
    expect(client.calls[1]?.sql).toContain("RETURNING");
  });

  test("persists only hashed broker codes and restores the verified Google identity", async () => {
    const client = new QueueSqlClient();
    const store = new SqlAuthorizationBrokerStore(client);

    await store.saveAuthorizationCode(authorizationCode);
    expect(client.calls[0]?.sql).toContain("INSERT INTO oauth_broker_codes");
    expect(client.calls[0]?.params[0]).toBe("hashed-broker-code");

    client.queue.push([
      {
        code_hash: authorizationCode.codeHash,
        client_id: authorizationCode.clientId,
        redirect_uri: authorizationCode.redirectUri,
        resource: authorizationCode.resource,
        scopes: authorizationCode.scopes,
        code_challenge: authorizationCode.codeChallenge,
        identity_issuer: authorizationCode.identity.issuer,
        identity_subject: authorizationCode.identity.subject,
        identity_email: authorizationCode.identity.email,
        identity_email_verified: true,
        expires_at: new Date(authorizationCode.expiresAt),
      },
    ]);
    expect(await store.consumeAuthorizationCode(authorizationCode.codeHash)).toEqual(
      authorizationCode,
    );
    expect(client.calls[1]?.sql).toContain("DELETE FROM oauth_broker_codes");
  });
});

describe("SQL constrained DCR store", () => {
  test("uses an atomic fixed-window query and stores only a digest of the caller bucket", async () => {
    const client = new QueueSqlClient([[{ allowed: true }], [{ allowed: false }]]);
    const store = new SqlDcrRegistrationStore(client);
    const policy = { maxAttempts: 2, maxKeys: 100, nowMs: 1_800_000_000_000, windowMs: 60_000 };

    expect(await store.consumeRegistrationAttempt("trusted-source", policy)).toBe("allowed");
    expect(await store.consumeRegistrationAttempt("trusted-source", policy)).toBe("limited");
    expect(client.calls[0]?.sql).toContain("pg_advisory_xact_lock");
    expect(client.calls[0]?.sql).toContain("ON CONFLICT");
    expect(client.calls[0]?.params).not.toContain("trusted-source");
  });

  test("atomically enforces dynamic capacity and restores unexpired registrations", async () => {
    const stored: StoredDynamicDcrClient = {
      registration: {
        client_id: "mcp_dynamic_client",
        client_id_issued_at: 1_800_000_000,
        redirect_uris: ["https://client.example/callback"],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: "mcp",
      },
      expiresAtMs: 1_800_086_400_000,
    };
    const client = new QueueSqlClient([
      [{ result: "saved" }],
      [{ registration: stored.registration, expires_at: new Date(stored.expiresAtMs) }],
    ]);
    const store = new SqlDcrRegistrationStore(client);

    expect(
      await store.saveDynamicClient(stored, {
        maxDynamicClients: 1000,
        nowMs: 1_800_000_000_000,
      }),
    ).toBe("saved");
    expect(client.calls[0]?.sql).toContain("pg_advisory_xact_lock");
    expect(client.calls[0]?.sql).toContain("live_capacity.count < $6");
    expect(await store.getDynamicClient("mcp_dynamic_client", 1_800_000_000_000)).toEqual(stored);
    expect(client.calls[1]?.sql).toContain("expires_at > $2");
  });
});

class QueueSqlClient implements SqlQueryClient {
  readonly calls: { sql: string; params: unknown[] }[] = [];

  constructor(readonly queue: Record<string, unknown>[][] = []) {}

  query(sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    this.calls.push({ sql, params });
    return Promise.resolve({ rows: this.queue.shift() ?? [] });
  }
}
