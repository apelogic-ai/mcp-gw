import type { Hop1Identity } from "../identity/hop1";
import { decryptSecret } from "./crypto";
import {
  DEFAULT_GOOGLE_TOKEN_URL,
  GoogleOAuthError,
  scopeStringToArray,
  type GoogleOAuthConfig,
  type OAuthFetch,
} from "./google";
import type { OAuthTokenStore } from "./store";

interface CachedAccessToken {
  token: string;
  expiresAt: number;
  scopes: string[];
}

export interface GoogleTokenBrokerOptions {
  config: GoogleOAuthConfig;
  tokenStore: OAuthTokenStore;
  fetch?: OAuthFetch;
  now?: () => number;
}

const EXPIRY_BUFFER_MS = 60_000;

export class GoogleTokenBroker {
  private readonly cache = new Map<string, CachedAccessToken>();
  private readonly inflight = new Map<string, Promise<string>>();
  private readonly fetchImpl: OAuthFetch;
  private readonly now: () => number;

  constructor(private readonly options: GoogleTokenBrokerOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async getAccessToken(identity: Hop1Identity, requiredScopes: string[]): Promise<string> {
    const key = cacheKey(identity);
    const cached = this.cache.get(key);
    if (
      cached &&
      cached.expiresAt > this.now() + EXPIRY_BUFFER_MS &&
      hasScopes(cached.scopes, requiredScopes)
    ) {
      return cached.token;
    }

    const pending = this.inflight.get(key);
    if (pending) {
      return pending;
    }

    const refresh = this.refreshAccessToken(identity, requiredScopes);
    this.inflight.set(key, refresh);
    try {
      return await refresh;
    } finally {
      this.inflight.delete(key);
    }
  }

  private async refreshAccessToken(
    identity: Hop1Identity,
    requiredScopes: string[],
  ): Promise<string> {
    const account = await this.options.tokenStore.getAccount(identity.issuer, identity.subject);
    if (!account || account.revokedAt) {
      throw new GoogleOAuthError("Google account must be reconnected", "reauth_required");
    }

    if (!hasScopes(account.scopesGranted, requiredScopes)) {
      throw new GoogleOAuthError(
        "Google account must be reconnected for additional scopes",
        "reauth_required",
      );
    }

    const refreshToken = decryptSecret(
      account.encryptedRefreshToken,
      this.options.config.tokenEncryptionKey,
    );
    const response = await this.fetchImpl(
      this.options.config.tokenUrl ?? DEFAULT_GOOGLE_TOKEN_URL,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.options.config.clientId,
          client_secret: this.options.config.clientSecret,
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        }),
      },
    );

    const body = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
      scope?: string;
      error?: string;
    };

    if (!response.ok || !body.access_token) {
      if (body.error === "invalid_grant") {
        await this.options.tokenStore.markRevoked(
          identity.issuer,
          identity.subject,
          new Date(this.now()),
        );
        throw new GoogleOAuthError("Google refresh token was revoked", "reauth_required");
      }

      throw new GoogleOAuthError(
        `Google token refresh failed: ${body.error ?? response.statusText}`,
        "token_exchange_failed",
      );
    }

    const scopes = scopeStringToArray(body.scope);
    this.cache.set(cacheKey(identity), {
      token: body.access_token,
      expiresAt: this.now() + (body.expires_in ?? 3600) * 1000,
      scopes,
    });

    return body.access_token;
  }
}

function cacheKey(identity: Hop1Identity): string {
  return `${identity.issuer}\n${identity.subject}`;
}

function hasScopes(granted: string[], required: string[]): boolean {
  const grantedSet = new Set(granted);
  return required.every((scope) => hasScope(grantedSet, scope));
}

function hasScope(granted: Set<string>, required: string): boolean {
  if (granted.has(required)) {
    return true;
  }

  return [...granted].some((scope) => scopeImplies(scope, required));
}

function scopeImplies(granted: string, required: string): boolean {
  if (granted === "https://www.googleapis.com/auth/drive") {
    return (
      required === "https://www.googleapis.com/auth/drive.readonly" ||
      required === "https://www.googleapis.com/auth/drive.file" ||
      required === "https://www.googleapis.com/auth/drive.metadata" ||
      required === "https://www.googleapis.com/auth/drive.metadata.readonly" ||
      required === "https://www.googleapis.com/auth/drive.appdata" ||
      required === "https://www.googleapis.com/auth/drive.apps.readonly" ||
      required === "https://www.googleapis.com/auth/drive.meet.readonly" ||
      required === "https://www.googleapis.com/auth/drive.photos.readonly" ||
      required === "https://www.googleapis.com/auth/drive.scripts"
    );
  }

  if (granted === "https://www.googleapis.com/auth/gmail.modify") {
    return (
      required === "https://www.googleapis.com/auth/gmail.readonly" ||
      required === "https://www.googleapis.com/auth/gmail.compose" ||
      required === "https://www.googleapis.com/auth/gmail.send" ||
      required === "https://www.googleapis.com/auth/gmail.insert" ||
      required === "https://www.googleapis.com/auth/gmail.labels" ||
      required === "https://www.googleapis.com/auth/gmail.metadata" ||
      required === "https://www.googleapis.com/auth/gmail.addons.current.action.compose" ||
      required === "https://www.googleapis.com/auth/gmail.addons.current.message.action" ||
      required === "https://www.googleapis.com/auth/gmail.addons.current.message.metadata" ||
      required === "https://www.googleapis.com/auth/gmail.addons.current.message.readonly"
    );
  }

  if (granted === "https://www.googleapis.com/auth/calendar") {
    return (
      required.startsWith("https://www.googleapis.com/auth/calendar.") ||
      required === "https://www.googleapis.com/auth/calendar.readonly" ||
      required === "https://www.googleapis.com/auth/calendar.freebusy"
    );
  }

  return (
    impliesReadonly(granted, required, "documents") ||
    impliesReadonly(granted, required, "spreadsheets") ||
    impliesReadonly(granted, required, "presentations") ||
    impliesReadonly(granted, required, "tasks")
  );
}

function impliesReadonly(granted: string, required: string, service: string): boolean {
  return (
    granted === `https://www.googleapis.com/auth/${service}` &&
    required === `https://www.googleapis.com/auth/${service}.readonly`
  );
}
