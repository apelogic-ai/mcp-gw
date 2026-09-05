import { describe, expect, test } from "bun:test";

import type {
  AuthorizationTransactionRecord,
  BrokerAuthorizationCodeRecord,
  BrokerRefreshTokenRecord,
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

const refreshToken: BrokerRefreshTokenRecord = {
  tokenHash: "hashed-client-refresh-token",
  familyId: "refresh-family-id",
  clientId: transaction.clientId,
  resource: transaction.resource,
  scopes: transaction.scopes,
  identity: authorizationCode.identity,
  expiresAt: Date.parse("2026-09-19T23:03:00.000Z"),
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

  test("persists only a refresh-token digest and atomically rotates a live token", async () => {
    const client = new QueueSqlClient([
      [],
      [{ family_id: refreshToken.familyId }],
      [],
      [
        {
          result: "rotated",
          family_id: refreshToken.familyId,
          client_id: refreshToken.clientId,
          resource: refreshToken.resource,
          scopes: refreshToken.scopes,
          identity_issuer: refreshToken.identity.issuer,
          identity_subject: refreshToken.identity.subject,
          identity_email: refreshToken.identity.email,
          identity_email_verified: true,
          expires_at: new Date(refreshToken.expiresAt),
        },
      ],
    ]);
    const store = new SqlAuthorizationBrokerStore(client);

    await store.saveRefreshToken(refreshToken);
    expect(client.calls[0]?.sql).toContain("INSERT INTO oauth_broker_refresh_tokens");
    expect(client.calls[0]?.params[0]).toBe("hashed-client-refresh-token");
    expect(client.calls[0]?.params).not.toContain("raw-client-refresh-token");

    const result = await store.rotateRefreshToken({
      tokenHash: refreshToken.tokenHash,
      replacementTokenHash: "hashed-rotated-token",
      clientId: refreshToken.clientId,
      resource: refreshToken.resource,
      scopes: refreshToken.scopes,
      now: Date.parse("2026-08-20T00:00:00.000Z"),
    });
    expect(result).toEqual({ status: "rotated", record: refreshToken });
    expect(client.transactionCalls).toBe(1);
    expect(client.calls[1]?.sql).toContain("SELECT family_id");
    expect(client.calls[2]?.sql).toContain("pg_advisory_xact_lock");
    expect(client.calls[3]?.sql).toContain("FOR UPDATE");
    expect(client.calls[3]?.sql).toContain("consumed_at");
    expect(client.calls[3]?.sql).toContain("revoked_at");
    expect(client.calls[3]?.sql).toContain("INSERT INTO oauth_broker_refresh_tokens");
    expect(client.calls[3]?.params).toContain("hashed-rotated-token");
  });

  test("surfaces replay so the complete refresh family is revoked", async () => {
    const client = new QueueSqlClient([
      [{ family_id: refreshToken.familyId }],
      [],
      [{ result: "replayed" }],
    ]);
    const store = new SqlAuthorizationBrokerStore(client);

    expect(
      await store.rotateRefreshToken({
        tokenHash: refreshToken.tokenHash,
        replacementTokenHash: "hashed-rotated-token",
        clientId: refreshToken.clientId,
        resource: refreshToken.resource,
        now: Date.parse("2026-08-20T00:00:00.000Z"),
      }),
    ).toEqual({ status: "replayed" });
    expect(client.calls[2]?.sql).toContain("family_id");
    expect(client.calls[2]?.sql).toContain("revoked_at");
  });

  test("serializes a refresh family before taking the rotation snapshot", async () => {
    const client = new QueueSqlClient([
      [{ family_id: refreshToken.familyId }],
      [],
      [{ result: "replayed" }],
    ]);
    const store = new SqlAuthorizationBrokerStore(client);

    expect(
      await store.rotateRefreshToken({
        tokenHash: refreshToken.tokenHash,
        replacementTokenHash: "hashed-rotated-token",
        clientId: refreshToken.clientId,
        resource: refreshToken.resource,
        now: Date.parse("2026-08-20T00:00:00.000Z"),
      }),
    ).toEqual({ status: "replayed" });
    expect(client.transactionCalls).toBe(1);
    expect(client.calls[0]?.sql).toContain("SELECT family_id");
    expect(client.calls[1]?.sql).toContain("pg_advisory_xact_lock");
    expect(client.calls[2]?.sql).toContain("FOR UPDATE");
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
    const expiresAtMs = 1_800_086_400_000;
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
      expiresAtMs,
    };
    const client = new QueueSqlClient([
      [{ result: "saved" }],
      [{ registration: stored.registration, expires_at: new Date(expiresAtMs) }],
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

  test("persists and restores a default non-expiring dynamic registration", async () => {
    const stored: StoredDynamicDcrClient = {
      registration: {
        client_id: "persistent_client",
        client_id_issued_at: 1_800_000_000,
        redirect_uris: ["https://client.example/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: "mcp",
      },
    };
    const client = new QueueSqlClient([
      [{ result: "saved" }],
      [{ registration: stored.registration, expires_at: null }],
    ]);
    const store = new SqlDcrRegistrationStore(client);

    expect(
      await store.saveDynamicClient(stored, {
        maxDynamicClients: 1000,
        nowMs: 1_800_000_000_000,
      }),
    ).toBe("saved");
    expect(client.calls[0]?.params[4]).toBeNull();
    expect(await store.getDynamicClient("persistent_client", 1_900_000_000_000)).toEqual(stored);
    expect(client.calls[1]?.sql).toContain("expires_at IS NULL");
  });
});

class QueueSqlClient implements SqlQueryClient {
  readonly calls: { sql: string; params: unknown[] }[] = [];
  transactionCalls = 0;

  constructor(readonly queue: Record<string, unknown>[][] = []) {}

  query(sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    this.calls.push({ sql, params });
    return Promise.resolve({ rows: this.queue.shift() ?? [] });
  }

  transaction<T>(operation: (client: SqlQueryClient) => Promise<T>): Promise<T> {
    this.transactionCalls += 1;
    return operation(this);
  }
}
