import { validateHop1IssuerProfiles, type Hop1IssuerConfig } from "../../../shared/identity/hop1";
import {
  createAuthenticator,
  createRemoteJwksProvider,
} from "../../../packages/wrapper-kit/src/authenticator";
import { createCliRunHandler, type CliTarget } from "./http";
import { createKubectlClassifier } from "./kubectl-classifier";
import { loadCliPack, verifyCliPackBinary, type CliPack } from "./pack";

export interface GovernedCliConfig {
  port: number;
  packPath: string;
  hop1Issuers: Hop1IssuerConfig[];
}

export function loadGovernedCliConfig(
  env: Readonly<Record<string, string | undefined>>,
): GovernedCliConfig {
  const rawIssuers = parseJson(required(env, "HOP1_ISSUERS_JSON"));
  if (!Array.isArray(rawIssuers) || rawIssuers.length === 0) {
    throw new Error("HOP1_ISSUERS_JSON must be a non-empty array");
  }
  return {
    port: integer(env.PORT, 8080, 1, 65_535),
    packPath: absolute(
      env.GOVERNED_CLI_PACK_PATH ?? "/app/servers/governed-cli/packs/kubectl/pack.yaml",
      "GOVERNED_CLI_PACK_PATH",
    ),
    hop1Issuers: validateHop1IssuerProfiles(
      rawIssuers.map((value) => issuerWithCredential(value, env)),
    ),
  };
}

export function createKubectlTarget(
  pack: CliPack,
  env: Readonly<Record<string, string | undefined>>,
): CliTarget {
  if (pack.credential.provider !== "kubernetes") {
    throw new Error("kubectl pack credential provider must be kubernetes");
  }
  return {
    catalog: pack.catalog,
    classifier: createKubectlClassifier(pack),
    runner: pack.runner,
    credentialEnv: () =>
      Promise.resolve().then(() => ({
        [pack.credential.targetEnv]: required(env, pack.credential.sourceEnv),
      })),
  };
}

export async function createGovernedCliHandler(
  config: GovernedCliConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<(request: Request) => Promise<Response>> {
  const pack = await loadCliPack(config.packPath);
  await verifyCliPackBinary(pack);
  const authenticate = createAuthenticator({
    issuers: config.hop1Issuers.map((profile) => ({
      profile,
      jwksProvider: createRemoteJwksProvider(profile.jwksUrl),
      ...(profile.introspectionUrl && profile.introspectionClientCredential
        ? {
            introspection: {
              url: profile.introspectionUrl,
              clientCredential: profile.introspectionClientCredential,
            },
          }
        : {}),
    })),
  });
  const run = createCliRunHandler({
    authenticate,
    targets: [createKubectlTarget(pack, env)],
    requestLimits: pack.requestLimits,
  });
  return (request) => {
    const path = new URL(request.url).pathname;
    if ((path === "/healthz" || path === "/readyz") && request.method === "GET") {
      return Promise.resolve(new Response("ok"));
    }
    return run(request);
  };
}

function issuerWithCredential(
  value: unknown,
  env: Readonly<Record<string, string | undefined>>,
): Hop1IssuerConfig {
  if (!isRecord(value)) throw new Error("Invalid HOP-1 issuer profile");
  const { introspectionClientCredentialEnv, ...profile } = value;
  const credentialEnv = optional(introspectionClientCredentialEnv);
  const credential = credentialEnv ? required(env, credentialEnv) : undefined;
  if (Boolean(profile.introspectionUrl) !== Boolean(credential)) {
    throw new Error("HOP-1 introspection URL and credential must be configured together");
  }
  return {
    ...(profile as unknown as Hop1IssuerConfig),
    ...(credential ? { introspectionClientCredential: credential } : {}),
  };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("Governed CLI JSON configuration is invalid");
  }
}

function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error("Governed CLI numeric configuration is invalid");
  }
  return parsed;
}

function absolute(value: string, field: string): string {
  if (!value.startsWith("/")) throw new Error(`${field} must be absolute`);
  return value;
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = optional(env[name]);
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function optional(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.main) {
  const config = loadGovernedCliConfig(process.env);
  const handler = await createGovernedCliHandler(config);
  Bun.serve({ port: config.port, fetch: handler });
}
