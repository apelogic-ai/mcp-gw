import type { AuditSink } from "../../../../shared/audit/audit";
import { startGoogleOAuth, type OAuthFetch } from "../../../../shared/oauth/google";
import type { ConnectionLifecycleMetricSink } from "../../../../shared/oauth/connection-metrics";
import { GoogleConnectionAdapter } from "../../../../shared/oauth/provider-adapters";
import { GoogleTokenBroker } from "../../../../shared/oauth/token-broker";
import type { OAuthStateStore, OAuthTokenStore } from "../../../../shared/oauth/store";
import type { ToolPolicy } from "../../../../shared/policy/policy";
import {
  createAuthenticator,
  createRemoteJwksProvider,
  type CreateAuthenticatorOptions,
  type IntrospectionConfig,
  type IntrospectionFetch,
  type JwksProvider,
  type TrustedIssuer,
} from "../../../../packages/wrapper-kit/src/authenticator";
import {
  createWrapperAuditSink,
  createWrapperPolicy,
} from "../../../../packages/wrapper-kit/src/configuration";
import {
  ConnectionLifecycle,
  googleOAuthCompatibilityStatus,
} from "../../../../packages/wrapper-kit/src/lifecycle";
import { createGoogleWorkspaceWrapperHandler, type WrapperConfig } from "./app";
import { executeGwsTool } from "./executor/gws";
import { PINNED_GWS_OPERATIONS } from "./google-workspace/operation-resolver";

export type RuntimeTrustedIssuer = TrustedIssuer;
export type RuntimeIntrospectionConfig = IntrospectionConfig;
export type RuntimeIntrospectionFetch = IntrospectionFetch;
export type CreateRuntimeAuthenticatorOptions = CreateAuthenticatorOptions;
export type { JwksProvider };

export interface CreateRuntimeWrapperHandlerOptions {
  config: WrapperConfig;
  tokenStore: OAuthTokenStore;
  issuers?: RuntimeTrustedIssuer[];
  audit?: AuditSink;
  metrics?: ConnectionLifecycleMetricSink;
  policy?: ToolPolicy;
  fetch?: OAuthFetch;
  providerOAuth?: {
    scopes: string[];
    stateStore: OAuthStateStore;
  };
}

export const createRuntimeAuthenticator = createAuthenticator;
export { createRemoteJwksProvider };

export function createRuntimeWrapperHandler(
  options: CreateRuntimeWrapperHandlerOptions,
): (request: Request) => Promise<Response> {
  const providerOAuth = options.providerOAuth;
  const audit = options.audit ?? createWrapperAuditSink(options.config.audit?.jsonlPath);
  const tokenBroker = new GoogleTokenBroker({
    config: options.config.oauth,
    tokenStore: options.tokenStore,
    fetch: options.fetch,
    audit,
    consentScopes: providerOAuth?.scopes,
    metrics: options.metrics,
  });
  const connectionLifecycle = new ConnectionLifecycle({
    adapter: new GoogleConnectionAdapter(options.config.oauth, options.fetch),
    store: options.tokenStore,
    credentialEncryptionKey: options.config.oauth.tokenEncryptionKey,
    audit,
    metrics: options.metrics,
  });

  return createGoogleWorkspaceWrapperHandler({
    serverInfo: {
      name: "google-workspace-wrapper",
      version: "0.1.0",
    },
    authenticate: createRuntimeAuthenticator({
      issuers:
        options.issuers ??
        options.config.hop1Issuers.map((issuer) => ({
          profile: issuer,
          jwksProvider: createRemoteJwksProvider(issuer.jwksUrl),
          introspection:
            issuer.introspectionUrl && issuer.introspectionClientCredential
              ? {
                  url: issuer.introspectionUrl,
                  clientCredential: issuer.introspectionClientCredential,
                }
              : undefined,
        })),
    }),
    audit,
    metrics: options.metrics,
    policy:
      options.policy ??
      createWrapperPolicy({
        config: options.config.policy,
        knownOperations: PINNED_GWS_OPERATIONS,
        fetch: options.fetch,
      }),
    governanceCatalogId: options.config.governanceCatalogId,
    getOAuthStatus: providerOAuth
      ? async (identity) => {
          const status = await connectionLifecycle.status(identity, providerOAuth.scopes);
          return googleOAuthCompatibilityStatus(status);
        }
      : undefined,
    startOAuth: providerOAuth
      ? (identity, redirectAfter) =>
          startGoogleOAuth({
            identity,
            scopes: providerOAuth.scopes,
            config: options.config.oauth,
            stateStore: providerOAuth.stateStore,
            tokenStore: options.tokenStore,
            redirectAfter,
          })
      : undefined,
    tokenBroker,
    executor: ({ tool, args, accessToken }) =>
      executeGwsTool({
        tool,
        args,
        accessToken,
        gwsBinary: options.config.gwsBinary,
      }),
  });
}
