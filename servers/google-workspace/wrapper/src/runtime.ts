import { decodeJwt, type JWK } from "jose";
import { readFileSync } from "node:fs";

import { JsonlAuditSink, type AuditSink } from "../../../../shared/audit/audit";
import {
  Hop1ValidationError,
  validateHop1Jwt,
  type Hop1Identity,
  type IssuerProfile,
} from "../../../../shared/identity/hop1";
import { startGoogleOAuth, type OAuthFetch } from "../../../../shared/oauth/google";
import { GoogleTokenBroker } from "../../../../shared/oauth/token-broker";
import type { OAuthStateStore, OAuthTokenStore } from "../../../../shared/oauth/store";
import {
  CompositePolicy,
  createOpaPolicyFromUrl,
  createYamlPolicyFromString,
  type ToolPolicy,
} from "../../../../shared/policy/policy";
import { createGoogleWorkspaceWrapperHandler, type WrapperConfig } from "./app";
import { executeGwsTool } from "./executor/gws";

export type JwksProvider = () => Promise<JWK[]>;

export interface RuntimeTrustedIssuer {
  profile: IssuerProfile;
  jwksProvider: JwksProvider;
  introspection?: RuntimeIntrospectionConfig;
}

export interface RuntimeIntrospectionConfig {
  url: string;
  clientCredential: string;
  fetch?: RuntimeIntrospectionFetch;
}

export type RuntimeIntrospectionFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface CreateRuntimeAuthenticatorOptions {
  issuers: RuntimeTrustedIssuer[];
}

export interface CreateRuntimeWrapperHandlerOptions {
  config: WrapperConfig;
  tokenStore: OAuthTokenStore;
  issuers?: RuntimeTrustedIssuer[];
  audit?: AuditSink;
  policy?: ToolPolicy;
  fetch?: OAuthFetch;
  providerOAuth?: {
    scopes: string[];
    stateStore: OAuthStateStore;
  };
}

export function createRuntimeAuthenticator(
  options: CreateRuntimeAuthenticatorOptions,
): (token: string) => Promise<Hop1Identity> {
  return async (token) => {
    let tokenIssuer: string | undefined;
    try {
      tokenIssuer = decodeJwt(token).iss;
    } catch {
      throw new Hop1ValidationError("HOP-1 token is malformed");
    }
    if (!tokenIssuer) {
      throw new Hop1ValidationError("HOP-1 token is missing its issuer");
    }

    const candidates = options.issuers.filter((issuer) => issuer.profile.issuer === tokenIssuer);
    if (candidates.length === 0) {
      throw new Hop1ValidationError("HOP-1 issuer is not trusted");
    }

    const validationErrors: string[] = [];
    let unavailableIssuers = 0;
    for (const issuer of candidates) {
      let jwks: JWK[];
      try {
        jwks = await issuer.jwksProvider();
      } catch {
        unavailableIssuers += 1;
        continue;
      }

      let identity: Hop1Identity;
      try {
        identity = await validateHop1Jwt(token, issuer.profile, jwks);
      } catch (error) {
        validationErrors.push(error instanceof Error ? error.message : String(error));
        continue;
      }
      if (issuer.introspection) {
        await requireActiveIntrospection(token, issuer.introspection);
      }
      return identity;
    }

    if (unavailableIssuers === candidates.length) {
      throw new Hop1ValidationError("HOP-1 issuer is unavailable");
    }
    throw new Hop1ValidationError(
      `HOP-1 token validation failed: ${validationErrors[0] ?? "no matching issuer profile"}`,
    );
  };
}

export function createRuntimeWrapperHandler(
  options: CreateRuntimeWrapperHandlerOptions,
): (request: Request) => Promise<Response> {
  const providerOAuth = options.providerOAuth;
  const tokenBroker = new GoogleTokenBroker({
    config: options.config.oauth,
    tokenStore: options.tokenStore,
    fetch: options.fetch,
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
    audit: options.audit ?? createAuditSink(options.config),
    policy: options.policy ?? createPolicy(options.config, options.fetch),
    getOAuthStatus: providerOAuth
      ? async (identity) => {
          const account = await options.tokenStore.getAccount(
            identity.issuer,
            identity.subject,
            "google",
          );
          if (!account || account.revokedAt) {
            return {
              connected: false,
              scopesRequired: providerOAuth.scopes,
              scopesGranted: [],
              missingScopes: providerOAuth.scopes,
            };
          }
          const missingScopes = missingRequiredScopes(providerOAuth.scopes, account.scopesGranted);
          return {
            connected: missingScopes.length === 0,
            email: account.email,
            scopesRequired: providerOAuth.scopes,
            scopesGranted: account.scopesGranted,
            missingScopes,
          };
        }
      : undefined,
    startOAuth: providerOAuth
      ? (identity, redirectAfter) =>
          startGoogleOAuth({
            identity,
            scopes: providerOAuth.scopes,
            config: options.config.oauth,
            stateStore: providerOAuth.stateStore,
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

function missingRequiredScopes(required: string[], granted: string[]): string[] {
  const grantedSet = new Set(granted);
  return required.filter((scope) => !grantedSet.has(scope));
}

async function requireActiveIntrospection(
  token: string,
  config: RuntimeIntrospectionConfig,
): Promise<void> {
  const fetchImpl = config.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(config.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.clientCredential}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ token }).toString(),
    });
  } catch {
    throw new Hop1ValidationError("HOP-1 introspection is unavailable");
  }
  if (!response.ok) {
    throw new Hop1ValidationError("HOP-1 introspection is unavailable");
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Hop1ValidationError("HOP-1 introspection returned an invalid response");
  }
  if (!isRecord(body) || body.active !== true) {
    throw new Hop1ValidationError("HOP-1 token is inactive");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createRemoteJwksProvider(
  jwksUrl: string,
  fetchImpl: OAuthFetch = fetch,
): JwksProvider {
  let cached: JWK[] | undefined;

  return async () => {
    if (cached) {
      return cached;
    }

    const response = await fetchImpl(jwksUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch JWKS: ${String(response.status)}`);
    }

    const body = (await response.json()) as { keys?: JWK[] };
    if (!body.keys) {
      throw new Error("JWKS response missing keys");
    }

    cached = body.keys;
    return cached;
  };
}

function createAuditSink(config: WrapperConfig): AuditSink | undefined {
  return config.audit?.jsonlPath ? new JsonlAuditSink(config.audit.jsonlPath) : undefined;
}

function createPolicy(
  config: WrapperConfig,
  fetchImpl: OAuthFetch | undefined,
): ToolPolicy | undefined {
  const policies: ToolPolicy[] = [];

  if (config.policy?.yamlFile) {
    policies.push(createYamlPolicyFromString(readFileSync(config.policy.yamlFile, "utf8")));
  }
  if (config.policy?.opaUrl) {
    policies.push(createOpaPolicyFromUrl(config.policy.opaUrl, fetchImpl));
  }

  if (policies.length === 0) {
    return undefined;
  }

  return policies.length === 1 ? policies[0] : new CompositePolicy(policies);
}
