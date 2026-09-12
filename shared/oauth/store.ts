import type { ConnectionRecord } from "./connection-types";

export type OAuthProvider = "google" | "github";

export interface OAuthStateRecord {
  stateHash: string;
  hop1Issuer: string;
  hop1Subject: string;
  email: string;
  requestedScopes: string[];
  redirectAfter?: string;
  expiresAt: Date;
  consumedAt?: Date;
  connectionGeneration?: number;
  connectionLocallyDisabled?: boolean;
  connectionUpdatedAt?: Date;
}

export interface OAuthStateStore {
  save(record: OAuthStateRecord): Promise<void>;
  consume(state: string): Promise<OAuthStateRecord | null>;
  invalidatePrincipal(hop1Issuer: string, hop1Subject: string): Promise<void>;
}

export interface OAuthAccountRecord {
  provider: OAuthProvider;
  hop1Issuer: string;
  hop1Subject: string;
  email: string;
  scopesGranted: string[];
  encryptedRefreshToken: string;
  createdAt: Date;
  updatedAt: Date;
  revokedAt?: Date;
}

export interface OAuthConnectionStore {
  getConnection(
    provider: OAuthProvider,
    hop1Issuer: string,
    hop1Subject: string,
  ): Promise<ConnectionRecord | null>;
  /**
   * Save a whole immutable-generation snapshot. When expectedGeneration is
   * supplied, a stale writer must return false without changing the row.
   */
  saveConnection(record: ConnectionRecord, expectedGeneration?: number): Promise<boolean>;
  listConnectionsPendingRevocation(
    provider: OAuthProvider,
    limit: number,
  ): Promise<ConnectionRecord[]>;
  markAuthorizing(
    provider: OAuthProvider,
    hop1Issuer: string,
    hop1Subject: string,
    requiredScopes: string[],
    expiresAt: Date,
  ): Promise<void>;
  clearAuthorizing(provider: OAuthProvider, hop1Issuer: string, hop1Subject: string): Promise<void>;
  withConnectionLock<T>(
    provider: OAuthProvider,
    hop1Issuer: string,
    hop1Subject: string,
    operation: (store: OAuthConnectionStore) => Promise<T>,
  ): Promise<T>;
}

export interface OAuthTokenStore extends OAuthConnectionStore {
  saveAccount(record: OAuthAccountRecord): Promise<void>;
  getAccount(
    hop1Issuer: string,
    hop1Subject: string,
    provider?: OAuthProvider,
  ): Promise<OAuthAccountRecord | null>;
  markRevoked(
    hop1Issuer: string,
    hop1Subject: string,
    revokedAt: Date,
    provider?: OAuthProvider,
  ): Promise<void>;
}
