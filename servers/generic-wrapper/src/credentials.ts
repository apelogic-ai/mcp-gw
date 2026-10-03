import { createHash } from "node:crypto";

import type { Hop1Identity } from "../../../shared/identity/hop1";
import type { GenericCredentialDescriptor } from "./descriptor";

export interface GenericUpstreamCredential {
  header: string;
  value: string;
}

export interface GenericCredentialRequest {
  identity: Hop1Identity;
  hop1Token: string;
  scopes: string[];
}

export interface GenericCredentialResolver {
  resolve(request: GenericCredentialRequest): Promise<GenericUpstreamCredential | null>;
}

export interface CreateGenericCredentialResolverOptions {
  fetch?: GenericCredentialFetch;
  oauthResolver?: (identity: Hop1Identity, scopes: string[]) => Promise<string | undefined>;
}

export type GenericCredentialFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface CachedExchange {
  credential: GenericUpstreamCredential;
  expiresAt: number;
}

export function createGenericCredentialResolver(
  descriptor: GenericCredentialDescriptor,
  env: Record<string, string | undefined>,
  options: CreateGenericCredentialResolverOptions = {},
): GenericCredentialResolver {
  if (descriptor.mode === "none") {
    return { resolve: () => Promise.resolve(null) };
  }
  if (descriptor.mode === "static_secret") {
    const secret = requiredEnv(env, descriptor.env);
    const value = descriptor.scheme ? `${descriptor.scheme} ${secret}` : secret;
    return {
      resolve: () => Promise.resolve({ header: descriptor.header, value }),
    };
  }
  if (descriptor.mode === "per_user_oauth") {
    if (!options.oauthResolver) {
      throw new Error("per_user_oauth requires an OAuth credential resolver");
    }
    return {
      resolve: async ({ identity, scopes }) => {
        const token = await options.oauthResolver?.(identity, scopes);
        return token
          ? {
              header: descriptor.header ?? "authorization",
              value: `${descriptor.scheme ?? "Bearer"} ${token}`,
            }
          : null;
      },
    };
  }

  const fetchImpl = options.fetch ?? fetch;
  const clientId = descriptor.clientIdEnv ? requiredEnv(env, descriptor.clientIdEnv) : undefined;
  const clientSecret = descriptor.clientSecretEnv
    ? requiredEnv(env, descriptor.clientSecretEnv)
    : undefined;
  const cache = new Map<string, CachedExchange>();
  return {
    resolve: async (request) => {
      const scopes = descriptor.scopes ?? request.scopes;
      const key = exchangeCacheKey(request, scopes);
      const cached = cache.get(key);
      if (cached && cached.expiresAt > Date.now() + 5_000) return cached.credential;

      const params = new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: request.hop1Token,
        subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
        requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      });
      if (descriptor.audience) params.set("audience", descriptor.audience);
      if (descriptor.resource) params.set("resource", descriptor.resource);
      if (scopes.length > 0) params.set("scope", scopes.join(" "));
      const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
      if (clientId && clientSecret) {
        headers.set(
          "authorization",
          `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        );
      }
      let response: Response;
      try {
        response = await fetchImpl(descriptor.endpoint, {
          method: "POST",
          headers,
          body: params.toString(),
          signal: AbortSignal.timeout(descriptor.timeoutMs ?? 5_000),
        });
      } catch {
        throw new Error("Token exchange is temporarily unavailable");
      }
      const body = await safeJson(response);
      if (!response.ok) throw new Error("Token exchange failed");
      if (!isRecord(body) || typeof body.access_token !== "string" || !body.access_token) {
        throw new Error("Token exchange response is malformed");
      }
      const tokenType =
        typeof body.token_type === "string" && body.token_type
          ? body.token_type
          : (descriptor.scheme ?? "Bearer");
      const credential = {
        header: descriptor.header ?? "authorization",
        value: `${tokenType} ${body.access_token}`,
      };
      const expiresIn =
        typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 60;
      cache.set(key, { credential, expiresAt: Date.now() + expiresIn * 1000 });
      return credential;
    },
  };
}

function exchangeCacheKey(request: GenericCredentialRequest, scopes: string[]): string {
  return createHash("sha256")
    .update(request.identity.issuer)
    .update("\0")
    .update(request.identity.subject)
    .update("\0")
    .update(request.hop1Token)
    .update("\0")
    .update([...scopes].sort().join(" "))
    .digest("hex");
}

function requiredEnv(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required credential environment variable: ${name}`);
  return value;
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
