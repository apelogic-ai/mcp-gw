import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

import type { PolicyActionClass } from "../../../shared/policy/policy";

export const GENERIC_WRAPPER_SCHEMA_VERSION = "mcp-gateway.generic-wrapper/v1" as const;
export const GENERIC_CATALOG_SCHEMA_VERSION = "mcp-gateway.generic-catalog/v1" as const;

export interface GenericServerInfo {
  name: string;
  version: string;
}

export type GenericUpstreamDescriptor =
  | { transport: "http"; url: string; timeoutMs?: number }
  | {
      transport: "stdio";
      command: string;
      args: string[];
      envAllowlist?: string[];
      credentialEnv?: string;
      timeoutMs?: number;
    };

export type GenericCredentialDescriptor =
  | { mode: "none" }
  | { mode: "static_secret"; env: string; header: string; scheme?: string }
  | {
      mode: "token_exchange";
      endpoint: string;
      audience?: string;
      resource?: string;
      scopes?: string[];
      clientIdEnv?: string;
      clientSecretEnv?: string;
      header?: string;
      scheme?: string;
      timeoutMs?: number;
    }
  | GenericOAuthCredentialDescriptor;

export interface GenericOAuthCredentialDescriptor {
  mode: "per_user_oauth";
  providerId: string;
  authorizationUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  revocationUrl?: string;
  redirectUri: string;
  scopes: string[];
  clientIdEnv: string;
  clientSecretEnv: string;
  encryptionKeyEnv: string;
  tokenStoreDsnEnv: string;
  header?: string;
  scheme?: string;
  identity: {
    idField: string;
    emailField: string;
    loginField?: string;
    emailVerifiedField?: string;
  };
  authorizationParams?: Record<string, string>;
  tokenEndpointAuthMethod?: "client_secret_basic" | "client_secret_post";
  timeoutMs?: number;
}

export interface GenericWrapperDescriptor {
  schemaVersion: typeof GENERIC_WRAPPER_SCHEMA_VERSION;
  name: string;
  toolPrefix: string;
  catalogPath: string;
  lifecycleRoutes: boolean;
  upstream: GenericUpstreamDescriptor;
  credential: GenericCredentialDescriptor;
  serverInfo: GenericServerInfo;
  policy?: { yamlFile?: string; opaUrl?: string };
  audit?: { jsonlPath?: string };
}

export interface GenericToolGrant {
  actionClass: PolicyActionClass;
  operation?: string;
  scopes: string[];
}

export interface GenericCatalogTool {
  exposedName: string;
  upstreamName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean };
  grants: GenericToolGrant;
}

export interface GenericToolCatalog {
  schemaVersion: typeof GENERIC_CATALOG_SCHEMA_VERSION;
  catalogId: string;
  tools: GenericCatalogTool[];
}

const NAME_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;
const TOOL_PREFIX_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
const ENV_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const HEADER_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const FIELD_PATH_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const OPERATION_PATTERN = /^[a-z][a-z0-9]*(?:\.[+a-z][a-zA-Z0-9]*){1,5}$/;

export function loadGenericWrapperDescriptor(path: string): GenericWrapperDescriptor {
  return parseGenericWrapperDescriptor(parseYaml(readFileSync(path, "utf8")));
}

export function loadGenericToolCatalog(path: string, toolPrefix: string): GenericToolCatalog {
  return parseGenericToolCatalog(parseYaml(readFileSync(path, "utf8")), toolPrefix);
}

export function parseGenericWrapperDescriptor(value: unknown): GenericWrapperDescriptor {
  const record = objectValue(value, "descriptor");
  assertAllowedFields(record, "descriptor", [
    "schemaVersion",
    "name",
    "toolPrefix",
    "catalogPath",
    "lifecycleRoutes",
    "upstream",
    "credential",
    "serverInfo",
    "policy",
    "audit",
  ]);
  if (record.schemaVersion !== GENERIC_WRAPPER_SCHEMA_VERSION) {
    throw new Error(`schemaVersion must be ${GENERIC_WRAPPER_SCHEMA_VERSION}`);
  }
  const name = patternString(record.name, "name", NAME_PATTERN);
  const toolPrefix = patternString(record.toolPrefix, "toolPrefix", TOOL_PREFIX_PATTERN);
  const catalogPath = nonEmptyString(record.catalogPath, "catalogPath");
  if (!catalogPath.startsWith("/")) throw new Error("catalogPath must be absolute");
  const lifecycleRoutes = optionalBoolean(record.lifecycleRoutes, "lifecycleRoutes") ?? false;
  const credentialRecord = objectValue(record.credential, "credential");
  if (credentialRecord.mode === "per_user_oauth" && !lifecycleRoutes) {
    throw new Error("per_user_oauth requires lifecycleRoutes=true");
  }

  return {
    schemaVersion: GENERIC_WRAPPER_SCHEMA_VERSION,
    name,
    toolPrefix,
    catalogPath,
    lifecycleRoutes,
    upstream: parseUpstream(record.upstream),
    credential: parseCredential(credentialRecord),
    serverInfo: parseServerInfo(record.serverInfo, name),
    policy: parsePolicy(record.policy),
    audit: parseAudit(record.audit),
  };
}

export function parseGenericToolCatalog(value: unknown, toolPrefix: string): GenericToolCatalog {
  patternString(toolPrefix, "toolPrefix", TOOL_PREFIX_PATTERN);
  const record = objectValue(value, "catalog");
  assertAllowedFields(record, "catalog", ["schemaVersion", "catalogId", "tools"]);
  if (record.schemaVersion !== GENERIC_CATALOG_SCHEMA_VERSION) {
    throw new Error(`catalog.schemaVersion must be ${GENERIC_CATALOG_SCHEMA_VERSION}`);
  }
  const toolsValue = record.tools;
  if (!Array.isArray(toolsValue) || toolsValue.length === 0) {
    throw new Error("catalog.tools must be a non-empty array");
  }
  const names = new Set<string>();
  const tools = toolsValue.map((value, index) => {
    const tool = parseCatalogTool(value, index, toolPrefix);
    if (names.has(tool.exposedName)) {
      throw new Error(`Duplicate catalog tool: ${tool.exposedName}`);
    }
    names.add(tool.exposedName);
    return tool;
  });
  return {
    schemaVersion: GENERIC_CATALOG_SCHEMA_VERSION,
    catalogId: nonEmptyString(record.catalogId, "catalog.catalogId"),
    tools,
  };
}

function parseUpstream(value: unknown): GenericUpstreamDescriptor {
  const record = objectValue(value, "upstream");
  if (record.transport === "http") {
    assertAllowedFields(record, "upstream", ["transport", "url", "timeoutMs"]);
    return {
      transport: "http",
      url: httpUrl(record.url, "upstream.url"),
      ...optionalPositiveIntegerProperty(record.timeoutMs, "upstream.timeoutMs", "timeoutMs"),
    };
  }
  if (record.transport === "stdio") {
    assertAllowedFields(record, "upstream", [
      "transport",
      "command",
      "args",
      "envAllowlist",
      "credentialEnv",
      "timeoutMs",
    ]);
    const command = nonEmptyString(record.command, "upstream.command");
    if (!command.startsWith("/")) throw new Error("upstream.command must be absolute");
    return {
      transport: "stdio",
      command,
      args: optionalStringArray(record.args, "upstream.args") ?? [],
      ...(record.envAllowlist === undefined
        ? {}
        : {
            envAllowlist: optionalStringArray(record.envAllowlist, "upstream.envAllowlist")?.map(
              (entry) => patternString(entry, "upstream.envAllowlist", ENV_PATTERN),
            ),
          }),
      ...optionalPatternProperty(
        record.credentialEnv,
        "upstream.credentialEnv",
        "credentialEnv",
        ENV_PATTERN,
      ),
      ...optionalPositiveIntegerProperty(record.timeoutMs, "upstream.timeoutMs", "timeoutMs"),
    };
  }
  throw new Error("upstream.transport must be http or stdio");
}

function parseCredential(record: Record<string, unknown>): GenericCredentialDescriptor {
  const mode = record.mode;
  if (mode === "none") {
    assertAllowedFields(record, "credential", ["mode"]);
    return { mode };
  }
  if (mode === "static_secret") {
    assertAllowedFields(record, "credential", ["mode", "env", "header", "scheme"]);
    return {
      mode,
      env: patternString(record.env, "credential.env", ENV_PATTERN),
      header: headerName(record.header, "credential.header"),
      ...optionalStringProperty(record.scheme, "credential.scheme", "scheme"),
    };
  }
  if (mode === "token_exchange") {
    assertAllowedFields(record, "credential", [
      "mode",
      "endpoint",
      "audience",
      "resource",
      "scopes",
      "clientIdEnv",
      "clientSecretEnv",
      "header",
      "scheme",
      "timeoutMs",
    ]);
    const clientIdEnv = optionalEnvName(record.clientIdEnv, "credential.clientIdEnv");
    const clientSecretEnv = optionalEnvName(record.clientSecretEnv, "credential.clientSecretEnv");
    if (Boolean(clientIdEnv) !== Boolean(clientSecretEnv)) {
      throw new Error("token exchange clientIdEnv and clientSecretEnv must be set together");
    }
    return {
      mode,
      endpoint: httpsUrl(record.endpoint, "credential.endpoint"),
      ...optionalStringProperty(record.audience, "credential.audience", "audience"),
      ...optionalStringProperty(record.resource, "credential.resource", "resource"),
      ...(record.scopes === undefined
        ? {}
        : { scopes: optionalStringArray(record.scopes, "credential.scopes") }),
      ...(clientIdEnv ? { clientIdEnv } : {}),
      ...(clientSecretEnv ? { clientSecretEnv } : {}),
      header:
        record.header === undefined
          ? "authorization"
          : headerName(record.header, "credential.header"),
      scheme:
        record.scheme === undefined ? "Bearer" : nonEmptyString(record.scheme, "credential.scheme"),
      ...optionalPositiveIntegerProperty(record.timeoutMs, "credential.timeoutMs", "timeoutMs"),
    };
  }
  if (mode === "per_user_oauth") return parseOAuthCredential(record);
  throw new Error("credential.mode is unsupported");
}

function parseOAuthCredential(record: Record<string, unknown>): GenericOAuthCredentialDescriptor {
  assertAllowedFields(record, "credential", [
    "mode",
    "providerId",
    "authorizationUrl",
    "tokenUrl",
    "userInfoUrl",
    "revocationUrl",
    "redirectUri",
    "scopes",
    "clientIdEnv",
    "clientSecretEnv",
    "encryptionKeyEnv",
    "tokenStoreDsnEnv",
    "header",
    "scheme",
    "identity",
    "authorizationParams",
    "tokenEndpointAuthMethod",
    "timeoutMs",
  ]);
  const identity = objectValue(record.identity, "credential.identity");
  assertAllowedFields(identity, "credential.identity", [
    "idField",
    "emailField",
    "loginField",
    "emailVerifiedField",
  ]);
  const authMethod = record.tokenEndpointAuthMethod;
  if (
    authMethod !== undefined &&
    authMethod !== "client_secret_basic" &&
    authMethod !== "client_secret_post"
  ) {
    throw new Error("credential.tokenEndpointAuthMethod is invalid");
  }
  return {
    mode: "per_user_oauth",
    providerId: patternString(record.providerId, "credential.providerId", NAME_PATTERN),
    authorizationUrl: httpsUrl(record.authorizationUrl, "credential.authorizationUrl"),
    tokenUrl: httpsUrl(record.tokenUrl, "credential.tokenUrl"),
    userInfoUrl: httpsUrl(record.userInfoUrl, "credential.userInfoUrl"),
    ...optionalUrlProperty(record.revocationUrl, "credential.revocationUrl", "revocationUrl"),
    redirectUri: httpsOrLoopbackUrl(record.redirectUri, "credential.redirectUri"),
    scopes: requiredStringArray(record.scopes, "credential.scopes"),
    clientIdEnv: patternString(record.clientIdEnv, "credential.clientIdEnv", ENV_PATTERN),
    clientSecretEnv: patternString(
      record.clientSecretEnv,
      "credential.clientSecretEnv",
      ENV_PATTERN,
    ),
    encryptionKeyEnv: patternString(
      record.encryptionKeyEnv,
      "credential.encryptionKeyEnv",
      ENV_PATTERN,
    ),
    tokenStoreDsnEnv: patternString(
      record.tokenStoreDsnEnv,
      "credential.tokenStoreDsnEnv",
      ENV_PATTERN,
    ),
    header:
      record.header === undefined
        ? "authorization"
        : headerName(record.header, "credential.header"),
    scheme:
      record.scheme === undefined ? "Bearer" : nonEmptyString(record.scheme, "credential.scheme"),
    identity: {
      idField: patternString(identity.idField, "credential.identity.idField", FIELD_PATH_PATTERN),
      emailField: patternString(
        identity.emailField,
        "credential.identity.emailField",
        FIELD_PATH_PATTERN,
      ),
      ...optionalPatternProperty(
        identity.loginField,
        "credential.identity.loginField",
        "loginField",
        FIELD_PATH_PATTERN,
      ),
      ...optionalPatternProperty(
        identity.emailVerifiedField,
        "credential.identity.emailVerifiedField",
        "emailVerifiedField",
        FIELD_PATH_PATTERN,
      ),
    },
    ...(record.authorizationParams === undefined
      ? {}
      : {
          authorizationParams: stringRecord(
            record.authorizationParams,
            "credential.authorizationParams",
          ),
        }),
    tokenEndpointAuthMethod: authMethod ?? "client_secret_basic",
    ...optionalPositiveIntegerProperty(record.timeoutMs, "credential.timeoutMs", "timeoutMs"),
  };
}

function parseCatalogTool(value: unknown, index: number, prefix: string): GenericCatalogTool {
  const name = `catalog.tools[${String(index)}]`;
  const record = objectValue(value, name);
  assertAllowedFields(record, name, [
    "name",
    "description",
    "inputSchema",
    "annotations",
    "grants",
  ]);
  const upstreamName = patternString(record.name, `${name}.name`, TOOL_NAME_PATTERN);
  const annotations = objectValue(record.annotations, `${name}.annotations`);
  assertAllowedFields(annotations, `${name}.annotations`, ["readOnlyHint", "destructiveHint"]);
  const grants = objectValue(record.grants, `${name}.grants`);
  assertAllowedFields(grants, `${name}.grants`, ["actionClass", "operation", "scopes"]);
  const actionClass = grants.actionClass;
  if (actionClass !== "read" && actionClass !== "write" && actionClass !== "destructive") {
    throw new Error(`${name}.grants.actionClass is invalid`);
  }
  return {
    upstreamName,
    exposedName: `${prefix}_${upstreamName}`,
    description: nonEmptyString(record.description, `${name}.description`),
    inputSchema: objectValue(record.inputSchema, `${name}.inputSchema`),
    annotations: {
      readOnlyHint: booleanValue(annotations.readOnlyHint, `${name}.annotations.readOnlyHint`),
      ...(annotations.destructiveHint === undefined
        ? {}
        : {
            destructiveHint: booleanValue(
              annotations.destructiveHint,
              `${name}.annotations.destructiveHint`,
            ),
          }),
    },
    grants: {
      actionClass,
      ...optionalPatternProperty(
        grants.operation,
        `${name}.grants.operation`,
        "operation",
        OPERATION_PATTERN,
      ),
      scopes:
        grants.scopes === undefined
          ? []
          : requiredStringArray(grants.scopes, `${name}.grants.scopes`, true),
    },
  };
}

function parseServerInfo(value: unknown, name: string): GenericServerInfo {
  if (value === undefined) return { name: `${name}-wrapper`, version: "1.0.0" };
  const record = objectValue(value, "serverInfo");
  assertAllowedFields(record, "serverInfo", ["name", "version"]);
  return {
    name: nonEmptyString(record.name, "serverInfo.name"),
    version: nonEmptyString(record.version, "serverInfo.version"),
  };
}

function parsePolicy(value: unknown): GenericWrapperDescriptor["policy"] {
  if (value === undefined) return undefined;
  const record = objectValue(value, "policy");
  assertAllowedFields(record, "policy", ["yamlFile", "opaUrl"]);
  const yamlFile = optionalString(record.yamlFile, "policy.yamlFile");
  const opaUrl = optionalString(record.opaUrl, "policy.opaUrl");
  return yamlFile || opaUrl
    ? { ...(yamlFile ? { yamlFile } : {}), ...(opaUrl ? { opaUrl } : {}) }
    : undefined;
}

function parseAudit(value: unknown): GenericWrapperDescriptor["audit"] {
  if (value === undefined) return undefined;
  const record = objectValue(value, "audit");
  assertAllowedFields(record, "audit", ["jsonlPath"]);
  const jsonlPath = optionalString(record.jsonlPath, "audit.jsonlPath");
  return jsonlPath ? { jsonlPath } : undefined;
}

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertAllowedFields(
  record: Record<string, unknown>,
  name: string,
  allowed: string[],
): void {
  const allowedSet = new Set(allowed);
  for (const field of Object.keys(record)) {
    if (!allowedSet.has(field)) {
      const label =
        name === "credential" ? "Unsupported credential field" : `Unsupported ${name} field`;
      throw new Error(`${label}: ${field}`);
    }
  }
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : nonEmptyString(value, name);
}

function patternString(value: unknown, name: string, pattern: RegExp): string {
  const result = nonEmptyString(value, name);
  if (!pattern.test(result)) throw new Error(`${name} has an invalid format`);
  return result;
}

function booleanValue(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  return value === undefined ? undefined : booleanValue(value, name);
}

function requiredStringArray(value: unknown, name: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(`${name} must be ${allowEmpty ? "an" : "a non-empty"} array`);
  }
  const result = value.map((entry) => nonEmptyString(entry, name));
  if (new Set(result).size !== result.length)
    throw new Error(`${name} must not contain duplicates`);
  return result;
}

function optionalStringArray(value: unknown, name: string): string[] | undefined {
  return value === undefined ? undefined : requiredStringArray(value, name, true);
}

function httpUrl(value: unknown, name: string): string {
  const result = nonEmptyString(value, name);
  const url = new URL(result);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) {
    throw new Error(`${name} must be an absolute HTTP(S) URL`);
  }
  return result;
}

function httpsUrl(value: unknown, name: string): string {
  const result = httpUrl(value, name);
  if (new URL(result).protocol !== "https:") throw new Error(`${name} must use HTTPS`);
  return result;
}

function httpsOrLoopbackUrl(value: unknown, name: string): string {
  const result = httpUrl(value, name);
  const url = new URL(result);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "::1"))
  ) {
    throw new Error(`${name} must use HTTPS or explicit loopback HTTP`);
  }
  return result;
}

function headerName(value: unknown, name: string): string {
  return patternString(value, name, HEADER_PATTERN).toLowerCase();
}

function optionalEnvName(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : patternString(value, name, ENV_PATTERN);
}

function optionalStringProperty(
  value: unknown,
  name: string,
  property: string,
): Record<string, string> {
  const parsed = optionalString(value, name);
  return parsed ? { [property]: parsed } : {};
}

function optionalPatternProperty(
  value: unknown,
  name: string,
  property: string,
  pattern: RegExp,
): Record<string, string> {
  return value === undefined ? {} : { [property]: patternString(value, name, pattern) };
}

function optionalUrlProperty(
  value: unknown,
  name: string,
  property: string,
): Record<string, string> {
  return value === undefined ? {} : { [property]: httpsUrl(value, name) };
}

function optionalPositiveIntegerProperty(
  value: unknown,
  name: string,
  property: string,
): Record<string, number> {
  if (value === undefined) return {};
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return { [property]: value };
}

function stringRecord(value: unknown, name: string): Record<string, string> {
  const record = objectValue(value, name);
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, nonEmptyString(entry, `${name}.${key}`)]),
  );
}
