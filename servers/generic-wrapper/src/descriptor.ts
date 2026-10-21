import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

import { OAUTH_PROVIDER_ID_PATTERN } from "../../../shared/oauth/store";

import type { PolicyActionClass } from "../../../shared/policy/policy";

export const GENERIC_WRAPPER_SCHEMA_VERSION = "mcp-gateway.generic-wrapper/v1" as const;
export const GENERIC_CATALOG_SCHEMA_VERSION = "mcp-gateway.generic-catalog/v1" as const;
export const GENERIC_TOOL_DECISIONS_SCHEMA_VERSION =
  "mcp-gateway.generic-tool-decisions/v1" as const;
export const ATLASSIAN_ACCESSIBLE_RESOURCES_URL =
  "https://api.atlassian.com/oauth/token/accessible-resources" as const;

export interface GenericServerInfo {
  name: string;
  version: string;
}

export interface GenericSessionLimits {
  maxTotal: number;
  maxPerPrincipal: number;
  idleTtlMs: number;
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
  identity: GenericOAuthIdentityDescriptor;
  authorizationParams?: Record<string, string>;
  tokenEndpointAuthMethod?: "client_secret_basic" | "client_secret_post";
  timeoutMs?: number;
}

export type GenericOAuthIdentityDescriptor =
  | {
      mode?: "verified_email";
      idField: string;
      emailField: string;
      loginField?: string;
      emailVerifiedField: string;
    }
  | {
      mode: "atlassian_jira_asserted_email";
      siteUrl: string;
    };

export interface GenericLifecycleToolNames {
  start: string;
  status: string;
}

export const DEFAULT_LIFECYCLE_TOOL_NAMES: GenericLifecycleToolNames = {
  start: "oauth_start",
  status: "oauth_status",
};

export interface GenericWrapperDescriptor {
  schemaVersion: typeof GENERIC_WRAPPER_SCHEMA_VERSION;
  name: string;
  toolPrefix: string;
  catalogPath: string;
  catalogFilter?: { actionClasses: PolicyActionClass[] };
  lifecycleRoutes: boolean;
  hideToolsUntilConnected: boolean;
  lifecycleToolNames: GenericLifecycleToolNames;
  upstream: GenericUpstreamDescriptor;
  credential: GenericCredentialDescriptor;
  serverInfo: GenericServerInfo;
  sessions: GenericSessionLimits;
  policy?: { yamlFile?: string; opaUrl?: string };
  audit?: { jsonlPath?: string };
}

export interface GenericToolGrant {
  actionClass: PolicyActionClass;
  operation?: string;
  scopes: string[];
}

export interface GenericGovernedTool {
  exposedName: string;
  upstreamName: string;
  alias?: string;
  grants: GenericToolGrant;
}

export interface GenericCatalogTool extends GenericGovernedTool {
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean };
}

export interface GenericToolCatalog {
  schemaVersion: typeof GENERIC_CATALOG_SCHEMA_VERSION;
  catalogId: string;
  tools: GenericCatalogTool[];
}

export interface GenericExcludedToolDecision {
  upstreamName: string;
  disposition: "exclude";
  reason: string;
}

export interface GenericIncludedToolDecision extends GenericGovernedTool {
  disposition: "include";
}

export type GenericToolDecision = GenericIncludedToolDecision | GenericExcludedToolDecision;

export interface GenericLiveToolCatalog {
  schemaVersion: typeof GENERIC_TOOL_DECISIONS_SCHEMA_VERSION;
  catalogId: string;
  mode: "live";
  decisions: GenericToolDecision[];
  tools: GenericIncludedToolDecision[];
}

export type GenericToolSource = GenericToolCatalog | GenericLiveToolCatalog;

const NAME_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;
const TOOL_PREFIX_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
const TOOL_ALIAS_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const ENV_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const HEADER_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const FIELD_PATH_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const OPERATION_PATTERN = /^[a-z][a-z0-9]*(?:\.[+a-z][a-zA-Z0-9]*){1,5}$/;
const DEFAULT_SESSION_LIMITS: GenericSessionLimits = {
  maxTotal: 64,
  maxPerPrincipal: 4,
  idleTtlMs: 30 * 60 * 1_000,
};
const RESERVED_PROVIDER_IDS = new Set(["google", "github"]);

export function loadGenericWrapperDescriptor(path: string): GenericWrapperDescriptor {
  return parseGenericWrapperDescriptor(parseYaml(readFileSync(path, "utf8")));
}

export function loadGenericToolCatalog(path: string, toolPrefix: string): GenericToolCatalog {
  return parseGenericToolCatalog(parseYaml(readFileSync(path, "utf8")), toolPrefix);
}

export function loadGenericToolSource(
  path: string,
  toolPrefix: string,
  filter?: GenericWrapperDescriptor["catalogFilter"],
): GenericToolSource {
  const value: unknown = parseYaml(readFileSync(path, "utf8"));
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).schemaVersion === GENERIC_TOOL_DECISIONS_SCHEMA_VERSION
  ) {
    return parseGenericToolDecisions(value, toolPrefix, filter);
  }
  if (filter) throw new Error("catalogFilter requires a live tool-decisions catalog");
  return parseGenericToolCatalog(value, toolPrefix);
}

export function parseGenericWrapperDescriptor(value: unknown): GenericWrapperDescriptor {
  const record = objectValue(value, "descriptor");
  assertAllowedFields(record, "descriptor", [
    "schemaVersion",
    "name",
    "toolPrefix",
    "catalogPath",
    "catalogFilter",
    "lifecycleRoutes",
    "hideToolsUntilConnected",
    "lifecycleToolNames",
    "upstream",
    "credential",
    "serverInfo",
    "sessions",
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
  const hideToolsUntilConnected =
    optionalBoolean(record.hideToolsUntilConnected, "hideToolsUntilConnected") ?? false;
  if (hideToolsUntilConnected && credentialRecord.mode !== "per_user_oauth") {
    throw new Error("hideToolsUntilConnected requires credential.mode=per_user_oauth");
  }

  return {
    schemaVersion: GENERIC_WRAPPER_SCHEMA_VERSION,
    name,
    toolPrefix,
    catalogPath,
    ...parseCatalogFilter(record.catalogFilter),
    lifecycleRoutes,
    hideToolsUntilConnected,
    lifecycleToolNames: parseLifecycleToolNames(record.lifecycleToolNames),
    upstream: parseUpstream(record.upstream),
    credential: parseCredential(credentialRecord),
    serverInfo: parseServerInfo(record.serverInfo, name),
    sessions: parseSessions(record.sessions),
    policy: parsePolicy(record.policy),
    audit: parseAudit(record.audit),
  };
}

function parseLifecycleToolNames(value: unknown): GenericLifecycleToolNames {
  if (value === undefined) return { ...DEFAULT_LIFECYCLE_TOOL_NAMES };
  const record = objectValue(value, "lifecycleToolNames");
  assertAllowedFields(record, "lifecycleToolNames", ["start", "status"]);
  const start =
    record.start === undefined
      ? DEFAULT_LIFECYCLE_TOOL_NAMES.start
      : patternString(record.start, "lifecycleToolNames.start", TOOL_NAME_PATTERN);
  const status =
    record.status === undefined
      ? DEFAULT_LIFECYCLE_TOOL_NAMES.status
      : patternString(record.status, "lifecycleToolNames.status", TOOL_NAME_PATTERN);
  if (start === status) throw new Error("lifecycleToolNames.start and status must differ");
  return { start, status };
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

export function parseGenericToolDecisions(
  value: unknown,
  toolPrefix: string,
  filter?: GenericWrapperDescriptor["catalogFilter"],
): GenericLiveToolCatalog {
  patternString(toolPrefix, "toolPrefix", TOOL_PREFIX_PATTERN);
  const record = objectValue(value, "decisions");
  assertAllowedFields(record, "decisions", ["schemaVersion", "catalogId", "tools"]);
  if (record.schemaVersion !== GENERIC_TOOL_DECISIONS_SCHEMA_VERSION) {
    throw new Error(`decisions.schemaVersion must be ${GENERIC_TOOL_DECISIONS_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(record.tools) || record.tools.length === 0) {
    throw new Error("decisions.tools must be a non-empty array");
  }
  const upstreamNames = new Set<string>();
  const exposedNames = new Set<string>();
  const decisions = record.tools.map((value, index) => {
    const decision = parseToolDecision(value, index, toolPrefix);
    if (upstreamNames.has(decision.upstreamName)) {
      throw new Error(`Duplicate tool decision: ${decision.upstreamName}`);
    }
    upstreamNames.add(decision.upstreamName);
    if (decision.disposition === "include") {
      if (exposedNames.has(decision.exposedName)) {
        throw new Error(`Duplicate exposed tool decision: ${decision.exposedName}`);
      }
      exposedNames.add(decision.exposedName);
    }
    return decision;
  });
  const allowedClasses = filter ? new Set(filter.actionClasses) : undefined;
  const tools = decisions.filter(
    (decision): decision is GenericIncludedToolDecision =>
      decision.disposition === "include" &&
      (!allowedClasses || allowedClasses.has(decision.grants.actionClass)),
  );
  if (tools.length === 0) throw new Error("live tool decisions select no tools");
  return {
    schemaVersion: GENERIC_TOOL_DECISIONS_SCHEMA_VERSION,
    catalogId: nonEmptyString(record.catalogId, "decisions.catalogId"),
    mode: "live",
    decisions,
    tools,
  };
}

export function validateGenericWrapperConfiguration(
  descriptor: GenericWrapperDescriptor,
  catalog: GenericToolSource,
): void {
  if (
    descriptor.upstream.transport === "stdio" &&
    descriptor.credential.mode !== "none" &&
    !descriptor.upstream.credentialEnv
  ) {
    throw new Error("A credentialed stdio upstream requires upstream.credentialEnv");
  }
  if (descriptor.credential.mode !== "per_user_oauth") return;
  if (RESERVED_PROVIDER_IDS.has(descriptor.credential.providerId)) {
    throw new Error(`OAuth providerId ${descriptor.credential.providerId} is reserved`);
  }
  const reserved = new Set([
    `${descriptor.toolPrefix}_${descriptor.lifecycleToolNames.status}`,
    `${descriptor.toolPrefix}_${descriptor.lifecycleToolNames.start}`,
  ]);
  const collision = catalog.tools.find((tool) => reserved.has(tool.exposedName));
  if (collision) {
    throw new Error(`Catalog tool ${collision.exposedName} collides with a lifecycle helper`);
  }
  const consentScopes = new Set(descriptor.credential.scopes);
  for (const tool of catalog.tools) {
    for (const scope of tool.grants.scopes) {
      if (!consentScopes.has(scope)) {
        throw new Error(
          `Catalog tool ${tool.exposedName} requires ${scope}, which is absent from OAuth consent scopes`,
        );
      }
    }
  }
}

export function isLiveToolCatalog(source: GenericToolSource): source is GenericLiveToolCatalog {
  return source.schemaVersion === GENERIC_TOOL_DECISIONS_SCHEMA_VERSION;
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
    const audience = optionalString(record.audience, "credential.audience");
    const resource = optionalString(record.resource, "credential.resource");
    if (!audience && !resource) {
      throw new Error("token exchange requires credential.audience or credential.resource");
    }
    return {
      mode,
      endpoint: httpsUrl(record.endpoint, "credential.endpoint"),
      ...(audience ? { audience } : {}),
      ...(resource ? { resource } : {}),
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
  const identity = parseOAuthIdentity(record.identity);
  const authMethod = record.tokenEndpointAuthMethod;
  if (
    authMethod !== undefined &&
    authMethod !== "client_secret_basic" &&
    authMethod !== "client_secret_post"
  ) {
    throw new Error("credential.tokenEndpointAuthMethod is invalid");
  }
  const providerId = patternString(
    record.providerId,
    "credential.providerId",
    OAUTH_PROVIDER_ID_PATTERN,
  );
  if (identity.mode === "atlassian_jira_asserted_email" && providerId !== "jira") {
    throw new Error(
      "credential.identity mode atlassian_jira_asserted_email requires providerId jira",
    );
  }
  const userInfoUrl = httpsUrl(record.userInfoUrl, "credential.userInfoUrl");
  if (
    identity.mode === "atlassian_jira_asserted_email" &&
    userInfoUrl !== ATLASSIAN_ACCESSIBLE_RESOURCES_URL
  ) {
    throw new Error(
      `credential.userInfoUrl must be the pinned Atlassian accessible-resources endpoint ${ATLASSIAN_ACCESSIBLE_RESOURCES_URL}`,
    );
  }
  const redirectUri = httpsOrLoopbackUrl(record.redirectUri, "credential.redirectUri");
  const parsedRedirect = new URL(redirectUri);
  const expectedCallbackPath = `/oauth/${providerId}/callback`;
  if (
    parsedRedirect.pathname !== expectedCallbackPath ||
    parsedRedirect.search.length > 0 ||
    parsedRedirect.hash.length > 0
  ) {
    throw new Error(
      `credential.redirectUri must use the exact callback path ${expectedCallbackPath} without query or fragment`,
    );
  }
  return {
    mode: "per_user_oauth",
    providerId,
    authorizationUrl: httpsUrl(record.authorizationUrl, "credential.authorizationUrl"),
    tokenUrl: httpsUrl(record.tokenUrl, "credential.tokenUrl"),
    userInfoUrl,
    ...optionalUrlProperty(record.revocationUrl, "credential.revocationUrl", "revocationUrl"),
    redirectUri,
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
    identity,
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

function parseOAuthIdentity(value: unknown): GenericOAuthIdentityDescriptor {
  const identity = objectValue(value, "credential.identity");
  if (identity.mode === "atlassian_jira_asserted_email") {
    assertAllowedFields(identity, "credential.identity", ["mode", "siteUrl"]);
    return {
      mode: "atlassian_jira_asserted_email",
      siteUrl: httpsOrigin(identity.siteUrl, "credential.identity.siteUrl"),
    };
  }
  if (identity.mode !== undefined && identity.mode !== "verified_email") {
    throw new Error("credential.identity.mode is invalid");
  }
  assertAllowedFields(identity, "credential.identity", [
    "mode",
    "idField",
    "emailField",
    "loginField",
    "emailVerifiedField",
  ]);
  return {
    ...(identity.mode === "verified_email" ? { mode: "verified_email" as const } : {}),
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
    emailVerifiedField: patternString(
      identity.emailVerifiedField,
      "credential.identity.emailVerifiedField",
      FIELD_PATH_PATTERN,
    ),
  };
}

function parseCatalogTool(value: unknown, index: number, prefix: string): GenericCatalogTool {
  const name = `catalog.tools[${String(index)}]`;
  const record = objectValue(value, name);
  assertAllowedFields(record, name, [
    "name",
    "alias",
    "description",
    "inputSchema",
    "annotations",
    "grants",
  ]);
  const upstreamName = patternString(record.name, `${name}.name`, TOOL_NAME_PATTERN);
  const alias =
    record.alias === undefined
      ? undefined
      : patternString(record.alias, `${name}.alias`, TOOL_ALIAS_PATTERN);
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
    exposedName: `${prefix}_${alias ?? upstreamName}`,
    ...(alias ? { alias } : {}),
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

function parseToolDecision(value: unknown, index: number, prefix: string): GenericToolDecision {
  const name = `decisions.tools[${String(index)}]`;
  const record = objectValue(value, name);
  const upstreamName = patternString(record.name, `${name}.name`, TOOL_NAME_PATTERN);
  if (record.disposition === "exclude") {
    assertAllowedFields(record, name, ["name", "disposition", "reason"]);
    return {
      upstreamName,
      disposition: "exclude",
      reason: nonEmptyString(record.reason, `${name}.reason`),
    };
  }
  if (record.disposition !== "include") {
    throw new Error(`${name}.disposition must be include or exclude`);
  }
  assertAllowedFields(record, name, [
    "name",
    "disposition",
    "alias",
    "actionClass",
    "operation",
    "scopes",
  ]);
  const alias = patternString(record.alias, `${name}.alias`, TOOL_ALIAS_PATTERN);
  const actionClass = record.actionClass;
  if (actionClass !== "read" && actionClass !== "write" && actionClass !== "destructive") {
    throw new Error(`${name}.actionClass is invalid`);
  }
  return {
    upstreamName,
    exposedName: `${prefix}_${alias}`,
    alias,
    disposition: "include",
    grants: {
      actionClass,
      ...optionalPatternProperty(
        record.operation,
        `${name}.operation`,
        "operation",
        OPERATION_PATTERN,
      ),
      scopes:
        record.scopes === undefined
          ? []
          : requiredStringArray(record.scopes, `${name}.scopes`, true),
    },
  };
}

function parseCatalogFilter(
  value: unknown,
): Pick<GenericWrapperDescriptor, "catalogFilter"> | Record<string, never> {
  if (value === undefined) return {};
  const record = objectValue(value, "catalogFilter");
  assertAllowedFields(record, "catalogFilter", ["actionClasses"]);
  if (!Array.isArray(record.actionClasses) || record.actionClasses.length === 0) {
    throw new Error("catalogFilter.actionClasses must be a non-empty array");
  }
  const actionClasses: PolicyActionClass[] = (record.actionClasses as unknown[]).map(
    (entry, index): PolicyActionClass => {
      if (entry !== "read" && entry !== "write" && entry !== "destructive") {
        throw new Error(`catalogFilter.actionClasses[${String(index)}] is invalid`);
      }
      return entry;
    },
  );
  if (new Set(actionClasses).size !== actionClasses.length) {
    throw new Error("catalogFilter.actionClasses must not contain duplicates");
  }
  return { catalogFilter: { actionClasses } };
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

function parseSessions(value: unknown): GenericSessionLimits {
  if (value === undefined) return { ...DEFAULT_SESSION_LIMITS };
  const record = objectValue(value, "sessions");
  assertAllowedFields(record, "sessions", ["maxTotal", "maxPerPrincipal", "idleTtlMs"]);
  const maxTotal = positiveIntegerOrDefault(
    record.maxTotal,
    "sessions.maxTotal",
    DEFAULT_SESSION_LIMITS.maxTotal,
  );
  const maxPerPrincipal = positiveIntegerOrDefault(
    record.maxPerPrincipal,
    "sessions.maxPerPrincipal",
    DEFAULT_SESSION_LIMITS.maxPerPrincipal,
  );
  if (maxPerPrincipal > maxTotal) {
    throw new Error("sessions.maxPerPrincipal must not exceed sessions.maxTotal");
  }
  return {
    maxTotal,
    maxPerPrincipal,
    idleTtlMs: positiveIntegerOrDefault(
      record.idleTtlMs,
      "sessions.idleTtlMs",
      DEFAULT_SESSION_LIMITS.idleTtlMs,
    ),
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
  let url: URL;
  try {
    url = new URL(result);
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) URL`);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) {
    throw new Error(`${name} must be an absolute HTTP(S) URL`);
  }
  if (url.username || url.password) throw new Error(`${name} must not contain credentials`);
  if (url.hash) throw new Error(`${name} must not contain a fragment`);
  return result;
}

function httpsUrl(value: unknown, name: string): string {
  const result = httpUrl(value, name);
  if (new URL(result).protocol !== "https:") throw new Error(`${name} must use HTTPS`);
  return result;
}

function httpsOrigin(value: unknown, name: string): string {
  const result = httpsUrl(value, name);
  const url = new URL(result);
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${name} must be an HTTPS origin without a path, query, or fragment`);
  }
  return url.origin;
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

function positiveIntegerOrDefault(value: unknown, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function stringRecord(value: unknown, name: string): Record<string, string> {
  const record = objectValue(value, name);
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, nonEmptyString(entry, `${name}.${key}`)]),
  );
}
