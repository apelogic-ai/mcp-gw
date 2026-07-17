import type {
  OAuthAccountRecord,
  OAuthProvider,
  OAuthStateRecord,
  OAuthStateStore,
  OAuthTokenStore,
} from "./store";
import { hashState } from "./state";

export class InMemoryOAuthStateStore implements OAuthStateStore {
  private readonly records = new Map<string, OAuthStateRecord>();

  save(record: OAuthStateRecord): Promise<void> {
    this.records.set(record.stateHash, { ...record });
    return Promise.resolve();
  }

  consume(state: string): Promise<OAuthStateRecord | null> {
    const stateHash = hashState(state);
    const record = this.records.get(stateHash);
    if (!record || record.consumedAt || record.expiresAt.getTime() <= Date.now()) {
      return Promise.resolve(null);
    }

    const consumed = {
      ...record,
      consumedAt: new Date(),
    };
    this.records.set(stateHash, consumed);
    return Promise.resolve(consumed);
  }
}

export class InMemoryOAuthTokenStore implements OAuthTokenStore {
  private readonly accounts = new Map<string, OAuthAccountRecord>();

  saveAccount(record: OAuthAccountRecord): Promise<void> {
    this.accounts.set(accountKey(record.provider, record.hop1Issuer, record.hop1Subject), {
      ...record,
    });
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
    }
    return Promise.resolve();
  }
}

function accountKey(provider: OAuthProvider, hop1Issuer: string, hop1Subject: string): string {
  return `${provider}\n${hop1Issuer}\n${hop1Subject}`;
}
