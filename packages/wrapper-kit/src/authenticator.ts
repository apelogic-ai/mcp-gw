import { decodeJwt, type JWK } from "jose";

import {
  Hop1ValidationError,
  validateHop1Jwt,
  type Hop1Identity,
  type IssuerProfile,
} from "../../../shared/identity/hop1";

export type JwksProvider = () => Promise<JWK[]>;

export interface TrustedIssuer {
  profile: IssuerProfile;
  jwksProvider: JwksProvider;
  introspection?: IntrospectionConfig;
}

export interface IntrospectionConfig {
  url: string;
  clientCredential: string;
  fetch?: IntrospectionFetch;
  timeoutMs?: number;
}

export type IntrospectionFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface CreateAuthenticatorOptions {
  issuers: TrustedIssuer[];
}

export function createAuthenticator(
  options: CreateAuthenticatorOptions,
): (token: string) => Promise<Hop1Identity> {
  return async (token) => {
    let tokenIssuer: string | undefined;
    try {
      tokenIssuer = decodeJwt(token).iss;
    } catch {
      throw new Hop1ValidationError("HOP-1 token is malformed", "malformed_token");
    }
    if (!tokenIssuer) {
      throw new Hop1ValidationError("HOP-1 token is missing its issuer", "untrusted_issuer");
    }

    const candidates = options.issuers.filter((issuer) => issuer.profile.issuer === tokenIssuer);
    if (candidates.length === 0) {
      throw new Hop1ValidationError("HOP-1 issuer is not trusted", "untrusted_issuer");
    }

    const validationErrors: Hop1ValidationError[] = [];
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
        validationErrors.push(
          error instanceof Hop1ValidationError
            ? error
            : new Hop1ValidationError(error instanceof Error ? error.message : String(error)),
        );
        continue;
      }
      if (issuer.introspection) {
        await requireActiveIntrospection(token, issuer.introspection);
      }
      return identity;
    }

    if (unavailableIssuers === candidates.length) {
      throw new Hop1ValidationError("HOP-1 issuer is unavailable", "jwks_unavailable");
    }
    throw new Hop1ValidationError(
      `HOP-1 token validation failed: ${validationErrors[0]?.message ?? "no matching issuer profile"}`,
      validationErrors[0]?.classification ?? "malformed_token",
    );
  };
}

export function createRemoteJwksProvider(
  jwksUrl: string,
  fetchImpl: IntrospectionFetch = fetch,
): JwksProvider {
  let cached: JWK[] | undefined;

  return async () => {
    if (cached) return cached;

    const response = await fetchImpl(jwksUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch JWKS: ${String(response.status)}`);
    }

    const body = (await response.json()) as { keys?: JWK[] };
    if (!body.keys) throw new Error("JWKS response missing keys");

    cached = body.keys;
    return cached;
  };
}

async function requireActiveIntrospection(
  token: string,
  config: IntrospectionConfig,
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
      signal: AbortSignal.timeout(config.timeoutMs ?? 5_000),
    });
  } catch {
    throw new Hop1ValidationError(
      "HOP-1 introspection is unavailable",
      "introspection_unavailable",
    );
  }
  if (!response.ok) {
    throw new Hop1ValidationError(
      "HOP-1 introspection is unavailable",
      "introspection_unavailable",
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Hop1ValidationError(
      "HOP-1 introspection returned an invalid response",
      "introspection_unavailable",
    );
  }
  if (!isRecord(body) || body.active !== true) {
    throw new Hop1ValidationError("HOP-1 token is inactive", "inactive_token");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
