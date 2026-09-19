import type { AuditSink } from "../audit/audit";
import type { ConnectionLifecycleMetricSink } from "./connection-metrics";
import type { Hop1Identity } from "../identity/hop1";
import { ConnectionLifecycle } from "./connection-lifecycle";
import {
  lifecycleErrorRequiresReauthorization,
  ProviderLifecycleError,
  ProviderToolScopeError,
  type ScopeRequirementInput,
} from "./connection-types";
import { GoogleOAuthError, type GoogleOAuthConfig, type OAuthFetch } from "./google";
import { GoogleConnectionAdapter } from "./provider-adapters";
import type { OAuthTokenStore } from "./store";

export interface GoogleTokenBrokerOptions {
  config: GoogleOAuthConfig;
  tokenStore: OAuthTokenStore;
  fetch?: OAuthFetch;
  now?: () => number;
  audit?: AuditSink;
  metrics?: ConnectionLifecycleMetricSink;
  consentScopes?: string[];
}

export class GoogleTokenBroker {
  constructor(private readonly options: GoogleTokenBrokerOptions) {}

  async getGrantedScopes(identity: Hop1Identity): Promise<string[]> {
    try {
      const record = await this.options.tokenStore.getConnection(
        "google",
        identity.issuer,
        identity.subject,
      );
      return [...(record?.grantedScopes ?? [])];
    } catch {
      throw new ProviderLifecycleError("Google grant lookup failed", "persistence_failure");
    }
  }

  async getAccessToken(
    identity: Hop1Identity,
    requiredScopes: ScopeRequirementInput,
    diagnosticId?: string,
    expectedGrantedScopes?: readonly string[],
  ): Promise<string> {
    const now = this.options.now;
    try {
      return await new ConnectionLifecycle({
        adapter: new GoogleConnectionAdapter(this.options.config, this.options.fetch),
        store: this.options.tokenStore,
        credentialEncryptionKey: this.options.config.tokenEncryptionKey,
        consentScopes: this.options.consentScopes,
        now: now ? () => new Date(now()) : undefined,
        audit: this.options.audit,
        metrics: this.options.metrics,
        diagnosticId,
      }).getActiveCredential(identity, requiredScopes, expectedGrantedScopes);
    } catch (error) {
      if (lifecycleErrorRequiresReauthorization(error)) {
        throw new GoogleOAuthError("Google account must be reconnected", "reauth_required");
      }
      if (error instanceof ProviderLifecycleError || error instanceof ProviderToolScopeError) {
        throw error;
      }
      throw new ProviderLifecycleError("Google credential brokerage failed", "persistence_failure");
    }
  }
}
