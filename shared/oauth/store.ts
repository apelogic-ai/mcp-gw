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
}

export interface OAuthStateStore {
  save(record: OAuthStateRecord): Promise<void>;
  consume(state: string): Promise<OAuthStateRecord | null>;
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

export interface OAuthTokenStore {
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
