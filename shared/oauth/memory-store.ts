import type {
  OAuthConnectionStore,
  OAuthAccountRecord,
  ConnectionWriteGuard,
  OAuthProvider,
  OAuthStateRecord,
  OAuthStateStore,
  OAuthTokenStore,
} from "./store";
import type {
  ConnectionRecord,
  CredentialGenerationRecord,
  CredentialGenerationState,
  PendingCredentialCleanupRecord,
} from "./connection-types";
import { hashState } from "./state";

export class InMemoryOAuthStateStore implements OAuthStateStore {
  private readonly records = new Map<string, OAuthStateRecord>();

  save(record: OAuthStateRecord): Promise<void> {
    this.records.set(record.stateHash, { ...record });
    return Promise.resolve();
  }

  consume(provider: OAuthProvider, state: string): Promise<OAuthStateRecord | null> {
    const stateHash = hashState(state);
    const record = this.records.get(stateHash);
    if (!record) return Promise.resolve(null);
    if (
      (record.provider !== undefined && record.provider !== provider) ||
      record.consumedAt ||
      record.expiresAt.getTime() <= Date.now()
    ) {
      return Promise.resolve(null);
    }

    const consumed = {
      ...record,
      consumedAt: new Date(),
    };
    this.records.set(stateHash, consumed);
    return Promise.resolve(consumed);
  }

  invalidatePrincipal(
    provider: OAuthProvider,
    hop1Issuer: string,
    hop1Subject: string,
  ): Promise<void> {
    const consumedAt = new Date();
    for (const [key, record] of this.records) {
      if (
        !record.consumedAt &&
        (record.provider === provider || record.provider === undefined) &&
        record.hop1Issuer === hop1Issuer &&
        record.hop1Subject === hop1Subject
      ) {
        this.records.set(key, { ...record, consumedAt });
      }
    }
    return Promise.resolve();
  }
}

export class InMemoryOAuthTokenStore implements OAuthTokenStore {
  private readonly accounts = new Map<string, OAuthAccountRecord>();
  private readonly connections = new Map<string, ConnectionRecord>();
  private readonly pendingCredentialCleanups = new Map<string, PendingCredentialCleanupRecord>();
  private readonly credentialGenerations = new Map<string, CredentialGenerationRecord>();
  private readonly authorizations = new Map<
    string,
    { requiredScopes: string[]; expiresAt: Date; updatedAt: Date }
  >();
  private readonly lockTails = new Map<string, Promise<void>>();

  saveAccount(record: OAuthAccountRecord): Promise<void> {
    const key = accountKey(record.provider, record.hop1Issuer, record.hop1Subject);
    this.accounts.set(key, {
      ...record,
    });
    const connection = this.connections.get(key);
    if (connection) {
      this.connections.set(key, {
        ...connection,
        displayAccountIdentity: record.email,
        grantedScopes: [...record.scopesGranted],
        encryptedLegacyCredential: record.encryptedRefreshToken,
        encryptedCredentialEnvelope: undefined,
        credentialSchemaVersion: undefined,
        activeCredentialPresent: record.provider === "github",
        renewalCredentialPresent: record.provider === "google",
        activeCredentialExpiresAt: undefined,
        renewalCredentialExpiresAt: undefined,
        localDisabledAt: record.revokedAt,
        lastAuthorizedAt: record.updatedAt,
        lastRenewedAt: undefined,
        lastValidatedAt: undefined,
        phase: record.revokedAt ? "disconnected" : "connected",
        revocationState: record.revokedAt ? "complete" : "none",
        revocationStartedAt: undefined,
        revocationCompletedAt: record.revokedAt,
        lifecycleErrorCategory: undefined,
        updatedAt: record.updatedAt,
      });
    }
    return Promise.resolve();
  }

  getAccount(
    hop1Issuer: string,
    hop1Subject: string,
    provider: OAuthProvider = "google",
  ): Promise<OAuthAccountRecord | null> {
    const record = this.accounts.get(accountKey(provider, hop1Issuer, hop1Subject));
    return Promise.resolve(record ? { ...record } : null);
  }

  markRevoked(
    hop1Issuer: string,
    hop1Subject: string,
    revokedAt: Date,
    provider: OAuthProvider = "google",
  ): Promise<void> {
    const key = accountKey(provider, hop1Issuer, hop1Subject);
    const record = this.accounts.get(key);
    if (record) {
      this.accounts.set(key, {
        ...record,
        revokedAt,
        updatedAt: revokedAt,
      });
      const connection = this.connections.get(key);
      if (connection) {
        this.connections.set(key, {
          ...connection,
          localDisabledAt: revokedAt,
          phase: "disconnected",
          revocationState: "complete",
          revocationCompletedAt: revokedAt,
          updatedAt: revokedAt,
        });
      }
    }
    return Promise.resolve();
  }

  getConnection(
    provider: OAuthProvider,
    hop1Issuer: string,
    hop1Subject: string,
  ): Promise<ConnectionRecord | null> {
    const key = accountKey(provider, hop1Issuer, hop1Subject);
    const connection = this.connections.get(key);
    const legacy = this.accounts.get(key);
    if (connection && !connection.localDisabledAt && connection.phase === "connected") {
      return Promise.resolve(cloneConnection(connection));
    }
    if (!connection && legacy && !legacy.revokedAt) {
      return Promise.resolve(connectionFromLegacy(legacy));
    }
    const authorization = this.authorizations.get(key);
    if (authorization && authorization.expiresAt.getTime() > Date.now()) {
      const underlying = connection ?? (legacy ? connectionFromLegacy(legacy) : undefined);
      if (underlying) {
        return Promise.resolve({
          ...cloneConnection(underlying),
          requiredScopes: [...authorization.requiredScopes],
          phase: "authorizing",
        });
      }
      return Promise.resolve({
        provider,
        hop1Issuer,
        hop1Subject,
        displayAccountIdentity: "",
        generation: 0,
        requiredScopes: [...authorization.requiredScopes],
        grantedScopes: [],
        activeCredentialPresent: false,
        renewalCredentialPresent: false,
        phase: "authorizing",
        revocationState: "none",
        createdAt: authorization.updatedAt,
        updatedAt: authorization.updatedAt,
        encryptedLegacyCredential: "",
      });
    }
    if (connection) return Promise.resolve(cloneConnection(connection));
    return Promise.resolve(legacy ? connectionFromLegacy(legacy) : null);
  }

  saveConnection(record: ConnectionRecord, guard: ConnectionWriteGuard): Promise<boolean> {
    const key = accountKey(record.provider, record.hop1Issuer, record.hop1Subject);
    const current = this.connections.get(key);
    const legacy = this.accounts.get(key);
    const exists = legacy !== undefined;
    const currentGeneration = current?.generation ?? (exists ? 1 : undefined);
    if (
      guard.exists !== exists ||
      (guard.exists &&
        (currentGeneration !== guard.generation ||
          legacy?.updatedAt.getTime() !== guard.updatedAt?.getTime() ||
          legacy?.revokedAt?.getTime() !== guard.revokedAt?.getTime()))
    ) {
      return Promise.resolve(false);
    }
    this.connections.set(key, cloneConnection(record));
    this.accounts.set(key, {
      provider: record.provider,
      hop1Issuer: record.hop1Issuer,
      hop1Subject: record.hop1Subject,
      email: record.displayAccountIdentity,
      scopesGranted: [...record.grantedScopes],
      encryptedRefreshToken: record.encryptedLegacyCredential,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      revokedAt: record.localDisabledAt,
    });
    return Promise.resolve(true);
  }

  listConnectionsPendingRevocation(
    provider: OAuthProvider,
    limit: number,
  ): Promise<ConnectionRecord[]> {
    return Promise.resolve(
      [...this.connections.values()]
        .filter((record) => record.provider === provider && record.revocationState === "pending")
        .sort((left, right) => left.updatedAt.getTime() - right.updatedAt.getTime())
        .slice(0, limit)
        .map(cloneConnection),
    );
  }

  savePendingCredentialCleanup(record: PendingCredentialCleanupRecord): Promise<void> {
    this.pendingCredentialCleanups.set(record.id, clonePendingCredentialCleanup(record));
    return Promise.resolve();
  }

  listPendingCredentialCleanups(
    provider: OAuthProvider,
    limit: number,
  ): Promise<PendingCredentialCleanupRecord[]> {
    return Promise.resolve(
      [...this.pendingCredentialCleanups.values()]
        .filter((record) => record.provider === provider)
        .sort((left, right) => left.updatedAt.getTime() - right.updatedAt.getTime())
        .slice(0, limit)
        .map(clonePendingCredentialCleanup),
    );
  }

  deletePendingCredentialCleanup(id: string): Promise<void> {
    this.pendingCredentialCleanups.delete(id);
    return Promise.resolve();
  }

  saveCredentialGeneration(record: CredentialGenerationRecord): Promise<void> {
    if (!this.credentialGenerations.has(record.id)) {
      this.credentialGenerations.set(record.id, cloneCredentialGeneration(record));
    }
    return Promise.resolve();
  }

  updateCredentialGeneration(
    record: CredentialGenerationRecord,
    expectedState: CredentialGenerationState,
  ): Promise<boolean> {
    const current = this.credentialGenerations.get(record.id);
    if (current?.state !== expectedState) return Promise.resolve(false);
    this.credentialGenerations.set(record.id, cloneCredentialGeneration(record));
    return Promise.resolve(true);
  }

  listPrincipalCredentialGenerations(
    provider: OAuthProvider,
    hop1Issuer: string,
    hop1Subject: string,
  ): Promise<CredentialGenerationRecord[]> {
    return Promise.resolve(
      [...this.credentialGenerations.values()]
        .filter(
          (record) =>
            record.provider === provider &&
            record.hop1Issuer === hop1Issuer &&
            record.hop1Subject === hop1Subject,
        )
        .map(cloneCredentialGeneration),
    );
  }

  listCredentialGenerationsForCleanup(
    provider: OAuthProvider,
    limit: number,
    now: Date,
  ): Promise<CredentialGenerationRecord[]> {
    return Promise.resolve(
      [...this.credentialGenerations.values()]
        .filter(
          (record) =>
            record.provider === provider &&
            ((record.state === "cleanup_pending" &&
              (!record.nextCleanupAttemptAt || record.nextCleanupAttemptAt <= now)) ||
              (record.state === "candidate" &&
                record.updatedAt.getTime() <= now.getTime() - 10 * 60 * 1000)),
        )
        .sort((left, right) => left.updatedAt.getTime() - right.updatedAt.getTime())
        .slice(0, limit)
        .map(cloneCredentialGeneration),
    );
  }

  markAuthorizing(
    provider: OAuthProvider,
    hop1Issuer: string,
    hop1Subject: string,
    requiredScopes: string[],
    expiresAt: Date,
  ): Promise<void> {
    this.authorizations.set(accountKey(provider, hop1Issuer, hop1Subject), {
      requiredScopes: [...requiredScopes],
      expiresAt,
      updatedAt: new Date(),
    });
    return Promise.resolve();
  }

  clearAuthorizing(
    provider: OAuthProvider,
    hop1Issuer: string,
    hop1Subject: string,
  ): Promise<void> {
    this.authorizations.delete(accountKey(provider, hop1Issuer, hop1Subject));
    return Promise.resolve();
  }

  async withConnectionLock<T>(
    provider: OAuthProvider,
    hop1Issuer: string,
    hop1Subject: string,
    operation: (store: OAuthConnectionStore) => Promise<T>,
  ): Promise<T> {
    const key = accountKey(provider, hop1Issuer, hop1Subject);
    const previous = this.lockTails.get(key) ?? Promise.resolve();
    let release = (): void => {
      throw new Error("connection lock resolver was not initialized");
    };
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => tail);
    this.lockTails.set(key, queued);
    await previous;
    try {
      return await operation(this);
    } finally {
      release();
      if (this.lockTails.get(key) === queued) this.lockTails.delete(key);
    }
  }
}

function accountKey(provider: OAuthProvider, hop1Issuer: string, hop1Subject: string): string {
  return `${provider}\n${hop1Issuer}\n${hop1Subject}`;
}

function cloneConnection(record: ConnectionRecord): ConnectionRecord {
  return {
    ...record,
    requiredScopes: [...record.requiredScopes],
    grantedScopes: [...record.grantedScopes],
  };
}

function clonePendingCredentialCleanup(
  record: PendingCredentialCleanupRecord,
): PendingCredentialCleanupRecord {
  return { ...record, grantedScopes: [...record.grantedScopes] };
}

function cloneCredentialGeneration(record: CredentialGenerationRecord): CredentialGenerationRecord {
  return { ...record, grantedScopes: [...record.grantedScopes] };
}

function connectionFromLegacy(legacy: OAuthAccountRecord): ConnectionRecord {
  return {
    provider: legacy.provider,
    hop1Issuer: legacy.hop1Issuer,
    hop1Subject: legacy.hop1Subject,
    displayAccountIdentity: legacy.email,
    generation: 1,
    requiredScopes: [],
    grantedScopes: [...legacy.scopesGranted],
    activeCredentialPresent: legacy.provider === "github",
    renewalCredentialPresent: legacy.provider === "google",
    lastAuthorizedAt: legacy.createdAt,
    localDisabledAt: legacy.revokedAt,
    phase: legacy.revokedAt ? "disconnected" : "connected",
    revocationState: legacy.revokedAt ? "complete" : "none",
    revocationCompletedAt: legacy.revokedAt,
    createdAt: legacy.createdAt,
    updatedAt: legacy.updatedAt,
    encryptedLegacyCredential: legacy.encryptedRefreshToken,
  };
}
