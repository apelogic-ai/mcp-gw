import { isAbsolute } from "node:path";
import { Pool } from "pg";

import {
  HOP1_SUPPORTED_ALGORITHMS,
  validateHop1IssuerProfiles,
  type Hop1Algorithm,
  type Hop1Identity,
  type Hop1IssuerConfig,
} from "../../../shared/identity/hop1";
import {
  lifecycleErrorRequiresReauthorization,
  ProviderLifecycleError,
  ProviderToolScopeError,
} from "../../../shared/oauth/connection-types";
import {
  createPostgresPoolConfig,
  createPostgresQueryClient,
} from "../../../shared/oauth/postgres-client";
import { createRevocationWorker } from "../../../shared/oauth/revocation-worker";
import { SqlOAuthStateStore, SqlOAuthTokenStore } from "../../../shared/oauth/sql-store";
import {
  createAuthenticator,
  createRemoteJwksProvider,
} from "../../../packages/wrapper-kit/src/authenticator";
import {
  createWrapperAuditSink,
  createWrapperPolicy,
} from "../../../packages/wrapper-kit/src/configuration";
import { createGenericCredentialResolver } from "./credentials";
import { loadGenericToolCatalog, loadGenericWrapperDescriptor } from "./descriptor";
import { createGenericOAuthRuntimeConfig, startGenericOAuth } from "./oauth";
import { createGenericOAuthRouteHandler } from "./oauth-routes";
import { createGenericMcpProxyHandler } from "./proxy";
import { createHttpUpstreamTransport, createStdioUpstreamTransport } from "./transport";

export interface GenericMainConfig {
  port: number;
  descriptorPath: string;
}

export function loadGenericMainConfig(env: Record<string, string | undefined>): GenericMainConfig {
  const descriptorPath = requiredEnv(env, "GENERIC_WRAPPER_DESCRIPTOR_PATH");
  if (!isAbsolute(descriptorPath)) {
    throw new Error("GENERIC_WRAPPER_DESCRIPTOR_PATH must be absolute");
  }
  const port = Number(env.PORT ?? "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return { port, descriptorPath };
}

export function createGenericMainHandler(
  config: GenericMainConfig,
  env: Record<string, string | undefined> = process.env,
): (request: Request) => Promise<Response> {
  const descriptor = loadGenericWrapperDescriptor(config.descriptorPath);
  const catalog = loadGenericToolCatalog(descriptor.catalogPath, descriptor.toolPrefix);
  const audit = createWrapperAuditSink(descriptor.audit?.jsonlPath);
  const policy = createWrapperPolicy({
    config: descriptor.policy,
    knownOperations: new Set(
      catalog.tools
        .map((tool) => tool.grants.operation)
        .filter((operation): operation is string => Boolean(operation)),
    ),
  });
  const issuers = loadGenericHop1Issuers(env).map((profile) => ({
    profile,
    jwksProvider: createRemoteJwksProvider(profile.jwksUrl),
    introspection:
      profile.introspectionUrl && profile.introspectionClientCredential
        ? {
            url: profile.introspectionUrl,
            clientCredential: profile.introspectionClientCredential,
          }
        : undefined,
  }));
  const authenticate = createAuthenticator({ issuers });
  const transport =
    descriptor.upstream.transport === "http"
      ? createHttpUpstreamTransport(descriptor.upstream)
      : createStdioUpstreamTransport(descriptor.upstream, env);

  let oauthRoutes: ((request: Request) => Promise<Response>) | undefined;
  let oauthHelpers:
    | {
        providerId: string;
        status(identity: Hop1Identity): Promise<Record<string, unknown>>;
        start(
          identity: Hop1Identity,
          redirectAfter?: string,
        ): Promise<{ authorizationUrl: string }>;
      }
    | undefined;

  if (descriptor.credential.mode === "per_user_oauth") {
    const oauthDescriptor = descriptor.credential;
    const oauthRuntime = createGenericOAuthRuntimeConfig(oauthDescriptor, env, { audit });
    const pool = new Pool(
      createPostgresPoolConfig(
        oauthRuntime.tokenStoreDsn,
        optionalEnv(env, "POSTGRES_CA_BUNDLE_PATH"),
      ),
    );
    const queryClient = createPostgresQueryClient(pool);
    const tokenStore = new SqlOAuthTokenStore(queryClient);
    const stateStore = new SqlOAuthStateStore(queryClient);
    const lifecycle = oauthRuntime.lifecycle(tokenStore);
    createRevocationWorker([lifecycle]).start();
    oauthRoutes = createGenericOAuthRouteHandler({
      authenticate,
      config: oauthRuntime,
      stateStore,
      tokenStore,
      audit,
    });
    oauthHelpers = {
      providerId: descriptor.credential.providerId,
      status: async (identity) => ({
        ...(await lifecycle.status(identity, oauthDescriptor.scopes)),
      }),
      start: async (identity, redirectAfter) => {
        if (redirectAfter && (!redirectAfter.startsWith("/") || redirectAfter.startsWith("//"))) {
          throw new Error("OAuth redirect target is not allowed");
        }
        const continuation = await startGenericOAuth({
          identity,
          config: oauthRuntime,
          stateStore,
          tokenStore,
          redirectAfter,
        });
        return { authorizationUrl: continuation.authorizationUrl };
      },
    };
    const credentialResolver = createGenericCredentialResolver(descriptor.credential, env, {
      oauthResolver: async (identity, scopes) => {
        try {
          return await lifecycle.getActiveCredential(identity, scopes);
        } catch (error) {
          if (
            error instanceof ProviderToolScopeError ||
            (error instanceof ProviderLifecycleError &&
              lifecycleErrorRequiresReauthorization(error))
          ) {
            return undefined;
          }
          throw error;
        }
      },
    });
    const mcpHandler = createGenericMcpProxyHandler({
      descriptor,
      catalog,
      authenticate,
      resolveCredential: (request) => credentialResolver.resolve(request),
      transport,
      policy,
      audit,
      oauth: oauthHelpers,
      requireCredential: true,
    });
    return (request) => {
      const path = new URL(request.url).pathname;
      return path.startsWith(`/connections/${oauthDescriptor.providerId}/`) ||
        path === `/oauth/${oauthDescriptor.providerId}/callback`
        ? (oauthRoutes?.(request) ?? Promise.resolve(new Response(null, { status: 404 })))
        : mcpHandler(request);
    };
  }

  const credentialResolver = createGenericCredentialResolver(descriptor.credential, env);
  return createGenericMcpProxyHandler({
    descriptor,
    catalog,
    authenticate,
    resolveCredential: (request) => credentialResolver.resolve(request),
    transport,
    policy,
    audit,
  });
}

function loadGenericHop1Issuers(env: Record<string, string | undefined>): Hop1IssuerConfig[] {
  const raw = requiredEnv(env, "HOP1_ISSUERS_JSON");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("HOP1_ISSUERS_JSON must be a non-empty array");
  }
  return validateHop1IssuerProfiles(
    parsed.map((value, index) => parseGenericHop1Issuer(value, index, env)),
  );
}

function parseGenericHop1Issuer(
  value: unknown,
  index: number,
  env: Record<string, string | undefined>,
): Hop1IssuerConfig {
  if (!isRecord(value)) {
    throw new Error(`HOP1_ISSUERS_JSON[${String(index)}] must be an object`);
  }
  const audiences = value.audiences;
  if (!Array.isArray(audiences) || audiences.some((entry) => typeof entry !== "string")) {
    throw new Error(`HOP1_ISSUERS_JSON[${String(index)}].audiences must be a string array`);
  }
  const algorithms = value.allowedAlgorithms;
  if (
    !Array.isArray(algorithms) ||
    algorithms.length === 0 ||
    algorithms.some(
      (entry) =>
        typeof entry !== "string" || !HOP1_SUPPORTED_ALGORITHMS.includes(entry as Hop1Algorithm),
    )
  ) {
    throw new Error(
      `HOP1_ISSUERS_JSON[${String(index)}].allowedAlgorithms must contain supported algorithms`,
    );
  }
  const introspectionUrl = optionalString(value.introspectionUrl);
  const credentialEnv = optionalString(value.introspectionClientCredentialEnv);
  const introspectionClientCredential = credentialEnv ? requiredEnv(env, credentialEnv) : undefined;
  if (Boolean(introspectionUrl) !== Boolean(introspectionClientCredential)) {
    throw new Error(
      `HOP1_ISSUERS_JSON[${String(index)}] introspectionUrl and introspectionClientCredentialEnv must be set together`,
    );
  }
  return {
    name: stringField(value, "name", index),
    issuer: stringField(value, "issuer", index),
    jwksUrl: stringField(value, "jwksUrl", index),
    audiences: audiences as string[],
    allowedAlgorithms: algorithms as Hop1Algorithm[],
    emailClaim: stringField(value, "emailClaim", index),
    ...(optionalString(value.subjectClaim)
      ? { subjectClaim: optionalString(value.subjectClaim) }
      : {}),
    ...(introspectionUrl && introspectionClientCredential
      ? { introspectionUrl, introspectionClientCredential }
      : {}),
  };
}

function stringField(record: Record<string, unknown>, name: string, index: number): string {
  const value = optionalString(record[name]);
  if (!value) {
    throw new Error(`HOP1_ISSUERS_JSON[${String(index)}].${name} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredEnv(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optionalEnv(env: Record<string, string | undefined>, name: string): string | undefined {
  return env[name]?.trim() || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.main) {
  const config = loadGenericMainConfig(process.env);
  const handler = createGenericMainHandler(config);
  Bun.serve({ port: config.port, fetch: handler });
  console.log(`generic MCP wrapper listening on ${String(config.port)}`);
}
