import type { ConnectionRecord, PendingCredentialCleanupRecord } from "./connection-types";

export type OAuthProvider = "google" | "github";

export interface OAuthStateRecord {
  /** Missing only on state rows written by replicas predating provider-scoped state. */
  provider?: OAuthProvider;
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
  /**
   * Consume a state for this provider. A legacy unbound row may be returned so
   * the callback can reject its incomplete guard and clear transient state.
   */
  consume(provider: OAuthProvider, state: string): Promise<OAuthStateRecord | null>;
  invalidatePrincipal(
    provider: OAuthProvider,
    hop1Issuer: string,
    hop1Subject: string,
  ): Promise<void>;
}

export interface ConnectionWriteGuard {
  exists: boolean;
  generation?: number;
  updatedAt?: Date;
  revokedAt?: Date;
}

export function connectionWriteGuard(record: ConnectionRecord | null): ConnectionWriteGuard {
  const syntheticAuthorization =
    record?.phase === "authorizing" &&
    record.generation === 0 &&
    !record.activeCredentialPresent &&
    !record.renewalCredentialPresent &&
    !record.localDisabledAt &&
    !record.displayAccountIdentity;
  return record
    ? syntheticAuthorization
      ? { exists: false }
      : {
          exists: true,
          generation: record.generation,
          updatedAt: record.updatedAt,
          revokedAt: record.localDisabledAt,
        }
    : { exists: false };
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
   * Save a whole immutable-generation snapshot. The guard covers both the
   * normalized generation and legacy fields changed by an older replica.
   */
  saveConnection(record: ConnectionRecord, guard: ConnectionWriteGuard): Promise<boolean>;
  listConnectionsPendingRevocation(
    provider: OAuthProvider,
    limit: number,
  ): Promise<ConnectionRecord[]>;
  savePendingCredentialCleanup(record: PendingCredentialCleanupRecord): Promise<void>;
  listPendingCredentialCleanups(
    provider: OAuthProvider,
    limit: number,
  ): Promise<PendingCredentialCleanupRecord[]>;
  deletePendingCredentialCleanup(id: string): Promise<void>;
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
