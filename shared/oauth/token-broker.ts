import type { AuditSink } from "../audit/audit";
import type { Hop1Identity } from "../identity/hop1";
import { ConnectionLifecycle } from "./connection-lifecycle";
import { GoogleOAuthError, type GoogleOAuthConfig, type OAuthFetch } from "./google";
import { GoogleConnectionAdapter } from "./provider-adapters";
import type { OAuthTokenStore } from "./store";

export interface GoogleTokenBrokerOptions {
  config: GoogleOAuthConfig;
  tokenStore: OAuthTokenStore;
  fetch?: OAuthFetch;
  now?: () => number;
  audit?: AuditSink;
}

export class GoogleTokenBroker {
  constructor(private readonly options: GoogleTokenBrokerOptions) {}

  async getAccessToken(identity: Hop1Identity, requiredScopes: string[]): Promise<string> {
    const now = this.options.now;
    try {
      return await new ConnectionLifecycle({
        adapter: new GoogleConnectionAdapter(this.options.config, this.options.fetch),
        store: this.options.tokenStore,
        credentialEncryptionKey: this.options.config.tokenEncryptionKey,
        now: now ? () => new Date(now()) : undefined,
        audit: this.options.audit,
      }).getActiveCredential(identity, requiredScopes);
    } catch {
      throw new GoogleOAuthError("Google account must be reconnected", "reauth_required");
    }
  }
}
