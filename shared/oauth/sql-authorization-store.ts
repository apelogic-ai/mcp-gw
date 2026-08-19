import { createHash } from "node:crypto";

import type {
  AuthorizationBrokerStore,
  AuthorizationTransactionRecord,
  BrokerAuthorizationCodeRecord,
  GoogleIdentity,
} from "./authorization-broker";
import type {
  DcrRegistrationResponse,
  DcrRegistrationStore,
  DcrStoreRateLimitPolicy,
  DcrStoreRegistrationPolicy,
  DcrStoreRegistrationResult,
  StoredDynamicDcrClient,
} from "./dcr";
import type { SqlQueryClient } from "./sql-store";

const DCR_RATE_LOCK = "mcp-gw-dcr-rate-limit";
const DCR_CLIENT_LOCK = "mcp-gw-dcr-client-capacity";

export class SqlAuthorizationBrokerStore implements AuthorizationBrokerStore {
  constructor(private readonly client: SqlQueryClient) {}

  async saveTransaction(record: AuthorizationTransactionRecord): Promise<void> {
    await this.client.query(
      `
WITH pruned AS (
  DELETE FROM oauth_broker_transactions WHERE expires_at <= NOW()
)
INSERT INTO oauth_broker_transactions (
  state_hash, client_id, redirect_uri, resource, scopes, client_state,
  code_challenge, google_nonce, google_code_verifier, expires_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
`,
      [
        record.stateHash,
        record.clientId,
        record.redirectUri,
        record.resource,
        record.scopes,
        record.clientState ?? null,
        record.codeChallenge,
        record.googleNonce,
        record.googleCodeVerifier,
        new Date(record.expiresAt),
      ],
    );
  }

  async consumeTransaction(stateHash: string): Promise<AuthorizationTransactionRecord | null> {
    const result = await this.client.query(
      `
DELETE FROM oauth_broker_transactions
WHERE state_hash = $1
  AND expires_at > NOW()
RETURNING state_hash, client_id, redirect_uri, resource, scopes, client_state,
  code_challenge, google_nonce, google_code_verifier, expires_at
`,
      [stateHash],
    );
    const row = result.rows[0];
    return row ? transactionFromRow(row) : null;
  }

  async saveAuthorizationCode(record: BrokerAuthorizationCodeRecord): Promise<void> {
    await this.client.query(
      `
WITH pruned AS (
  DELETE FROM oauth_broker_codes WHERE expires_at <= NOW()
)
INSERT INTO oauth_broker_codes (
  code_hash, client_id, redirect_uri, resource, scopes, code_challenge,
  identity_issuer, identity_subject, identity_email, identity_email_verified, expires_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
`,
      [
        record.codeHash,
        record.clientId,
        record.redirectUri,
        record.resource,
        record.scopes,
        record.codeChallenge,
        record.identity.issuer,
        record.identity.subject,
        record.identity.email,
        record.identity.emailVerified,
        new Date(record.expiresAt),
      ],
    );
  }

  async consumeAuthorizationCode(codeHash: string): Promise<BrokerAuthorizationCodeRecord | null> {
    const result = await this.client.query(
      `
DELETE FROM oauth_broker_codes
WHERE code_hash = $1
  AND expires_at > NOW()
RETURNING code_hash, client_id, redirect_uri, resource, scopes, code_challenge,
  identity_issuer, identity_subject, identity_email, identity_email_verified, expires_at
`,
      [codeHash],
    );
    const row = result.rows[0];
    return row ? authorizationCodeFromRow(row) : null;
  }
}

export class SqlDcrRegistrationStore implements DcrRegistrationStore {
  constructor(private readonly client: SqlQueryClient) {}

  async consumeRegistrationAttempt(
    rateLimitKey: string,
    policy: DcrStoreRateLimitPolicy,
  ): Promise<"allowed" | "limited"> {
    const keyHash = createHash("sha256").update(rateLimitKey).digest("base64url");
    const result = await this.client.query(
      `
WITH lock AS MATERIALIZED (
  SELECT pg_advisory_xact_lock(hashtextextended($1, 0))
), pruned AS (
  DELETE FROM oauth_dcr_rate_limits
  WHERE expires_at <= $2
  RETURNING 1
), live_capacity AS (
  SELECT COUNT(*)::INTEGER AS count
  FROM oauth_dcr_rate_limits, lock
  WHERE expires_at > $2
), upserted AS (
  INSERT INTO oauth_dcr_rate_limits (rate_limit_key_hash, attempts, expires_at)
  SELECT $3, 1, $4
  FROM lock, live_capacity
  WHERE EXISTS (
    SELECT 1 FROM oauth_dcr_rate_limits WHERE rate_limit_key_hash = $3
  ) OR live_capacity.count < $5
  ON CONFLICT (rate_limit_key_hash)
  DO UPDATE SET
    attempts = CASE
      WHEN oauth_dcr_rate_limits.expires_at <= $2 THEN 1
      ELSE oauth_dcr_rate_limits.attempts + 1
    END,
    expires_at = CASE
      WHEN oauth_dcr_rate_limits.expires_at <= $2 THEN $4
      ELSE oauth_dcr_rate_limits.expires_at
    END
  WHERE oauth_dcr_rate_limits.expires_at <= $2
     OR oauth_dcr_rate_limits.attempts < $6
  RETURNING 1
)
SELECT EXISTS(SELECT 1 FROM upserted) AS allowed
`,
      [
        DCR_RATE_LOCK,
        new Date(policy.nowMs),
        keyHash,
        new Date(policy.nowMs + policy.windowMs),
        policy.maxKeys,
        policy.maxAttempts,
      ],
    );
    return result.rows[0]?.allowed === true ? "allowed" : "limited";
  }

  async getDynamicClient(clientId: string, nowMs: number): Promise<StoredDynamicDcrClient | null> {
    const result = await this.client.query(
      `
SELECT registration, expires_at
FROM oauth_dcr_clients
WHERE client_id = $1
  AND expires_at > $2
LIMIT 1
`,
      [clientId, new Date(nowMs)],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      registration: registrationFromRow(row.registration),
      expiresAtMs: dateField(row, "expires_at").getTime(),
    };
  }

  async saveDynamicClient(
    client: StoredDynamicDcrClient,
    policy: DcrStoreRegistrationPolicy,
  ): Promise<DcrStoreRegistrationResult> {
    const result = await this.client.query(
      `
WITH lock AS MATERIALIZED (
  SELECT pg_advisory_xact_lock(hashtextextended($1, 0))
), pruned AS (
  DELETE FROM oauth_dcr_clients
  WHERE expires_at <= $3
  RETURNING 1
), existing AS (
  SELECT 1
  FROM oauth_dcr_clients, lock
  WHERE client_id = $2
), live_capacity AS (
  SELECT COUNT(*)::INTEGER AS count
  FROM oauth_dcr_clients, lock
  WHERE expires_at > $3
), inserted AS (
  INSERT INTO oauth_dcr_clients (client_id, registration, expires_at)
  SELECT $2, $4::JSONB, $5
  FROM lock, live_capacity
  WHERE NOT EXISTS (SELECT 1 FROM existing)
    AND live_capacity.count < $6
  ON CONFLICT (client_id) DO NOTHING
  RETURNING 1
)
SELECT CASE
  WHEN EXISTS (SELECT 1 FROM existing) THEN 'duplicate'
  WHEN EXISTS (SELECT 1 FROM inserted) THEN 'saved'
  ELSE 'full'
END AS result
`,
      [
        DCR_CLIENT_LOCK,
        client.registration.client_id,
        new Date(policy.nowMs),
        JSON.stringify(client.registration),
        new Date(client.expiresAtMs),
        policy.maxDynamicClients,
      ],
    );
    const value = result.rows[0]?.result;
    if (value === "saved" || value === "duplicate" || value === "full") {
      return value;
    }
    throw new Error("DCR client persistence returned an invalid result");
  }
}

function transactionFromRow(row: Record<string, unknown>): AuthorizationTransactionRecord {
  return {
    stateHash: stringField(row, "state_hash"),
    clientId: stringField(row, "client_id"),
    redirectUri: stringField(row, "redirect_uri"),
    resource: stringField(row, "resource"),
    scopes: stringArrayField(row, "scopes"),
    clientState: optionalStringField(row, "client_state"),
    codeChallenge: stringField(row, "code_challenge"),
    googleNonce: stringField(row, "google_nonce"),
    googleCodeVerifier: stringField(row, "google_code_verifier"),
    expiresAt: dateField(row, "expires_at").getTime(),
  };
}

function authorizationCodeFromRow(row: Record<string, unknown>): BrokerAuthorizationCodeRecord {
  const identity: GoogleIdentity = {
    issuer: stringField(row, "identity_issuer"),
    subject: stringField(row, "identity_subject"),
    email: stringField(row, "identity_email"),
    emailVerified: booleanTrueField(row, "identity_email_verified"),
  };
  return {
    codeHash: stringField(row, "code_hash"),
    clientId: stringField(row, "client_id"),
    redirectUri: stringField(row, "redirect_uri"),
    resource: stringField(row, "resource"),
    scopes: stringArrayField(row, "scopes"),
    codeChallenge: stringField(row, "code_challenge"),
    identity,
    expiresAt: dateField(row, "expires_at").getTime(),
  };
}

function registrationFromRow(value: unknown): DcrRegistrationResponse {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected SQL registration field to be a JSON object");
  }
  return structuredClone(parsed) as DcrRegistrationResponse;
}

function stringField(row: Record<string, unknown>, name: string): string {
  const value = row[name];
  if (typeof value !== "string") {
    throw new Error(`Expected SQL field ${name} to be a string`);
  }
  return value;
}

function optionalStringField(row: Record<string, unknown>, name: string): string | undefined {
  const value = row[name];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Expected SQL field ${name} to be a string`);
  }
  return value;
}

function stringArrayField(row: Record<string, unknown>, name: string): string[] {
  const value = row[name];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`Expected SQL field ${name} to be a string array`);
  }
  return [...value];
}

function dateField(row: Record<string, unknown>, name: string): Date {
  const value = row[name];
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === "string") {
    return new Date(value);
  }
  throw new Error(`Expected SQL field ${name} to be a date`);
}

function booleanTrueField(row: Record<string, unknown>, name: string): true {
  if (row[name] !== true) {
    throw new Error(`Expected SQL field ${name} to be true`);
  }
  return true;
}
