export const TASK_TOOL_DENIED_ERROR = "task_tool_not_approved" as const;
export const TASK_TOOL_DENIED_MESSAGE = "Tool is not approved for this Task" as const;

const TASK_AUTHORITY_CLAIM = ["ste", "ward"].join("");
const CONTROL_PLANE_SERVICE = ["ste", "ward-apiserver"].join("");
const CURRENT_TASK_AUTHORITY_CLAIMS_VERSION = 3;
const CONNECTION_STATUS_PURPOSE = "provider_connection_status";
const LEGACY_OPT_OUT_ENV = "MCP_GW_ALLOW_LEGACY_UNSCOPED_TASK_TOKENS";

export interface TaskToolGrant {
  provider: string;
  resource: string;
  action: string;
}

export interface TaskToolAuthorizationOptions {
  allowLegacyUnscopedTaskTokens?: boolean;
}

export interface TaskToolAuthorization {
  readonly restricted: boolean;
  readonly allowsConnectionHelpers: boolean;
  allows(grant: TaskToolGrant): boolean;
  allowsAny(grants: readonly TaskToolGrant[]): boolean;
}

const UNRESTRICTED: TaskToolAuthorization = {
  restricted: false,
  allowsConnectionHelpers: true,
  allows: () => true,
  allowsAny: () => true,
};

export function parseTaskToolAuthorization(
  claims: Readonly<Record<string, unknown>>,
  options: TaskToolAuthorizationOptions = {},
): TaskToolAuthorization {
  if (!(TASK_AUTHORITY_CLAIM in claims)) return UNRESTRICTED;

  const authority = record(claims[TASK_AUTHORITY_CLAIM]);
  const connectionStatusGrant = connectionStatusAuthorityGrant(authority);
  if (connectionStatusGrant) return restrictedAuthorization([connectionStatusGrant], false);

  const taskMarkerIsValid = isCurrentTaskMarker(authority);
  if (
    isLegacyTaskMarker(authority) &&
    authority?.tools === undefined &&
    options.allowLegacyUnscopedTaskTokens === true
  ) {
    return UNRESTRICTED;
  }

  if (!taskMarkerIsValid || !Array.isArray(authority?.tools)) {
    return restrictedAuthorization([]);
  }

  const grants: TaskToolGrant[] = [];
  for (const value of authority.tools) {
    const grant = parseGrant(value);
    if (!grant) return restrictedAuthorization([]);
    grants.push(grant);
  }
  return restrictedAuthorization(grants);
}

export function readTaskToolAuthorizationOptions(
  env: Readonly<Record<string, string | undefined>>,
): Required<TaskToolAuthorizationOptions> {
  const raw = env[LEGACY_OPT_OUT_ENV]?.trim();
  if (raw === undefined || raw === "" || raw === "false") {
    return { allowLegacyUnscopedTaskTokens: false };
  }
  if (raw === "true") {
    return { allowLegacyUnscopedTaskTokens: true };
  }
  throw new Error(`${LEGACY_OPT_OUT_ENV} must be true or false`);
}

function restrictedAuthorization(
  grants: readonly TaskToolGrant[],
  allowsConnectionHelpers = true,
): TaskToolAuthorization {
  const allowed = new Set(grants.map(grantKey));
  return {
    restricted: true,
    allowsConnectionHelpers,
    allows: (grant) => allowed.has(grantKey(grant)),
    allowsAny: (candidates) => candidates.some((grant) => allowed.has(grantKey(grant))),
  };
}

function connectionStatusAuthorityGrant(
  authority: Record<string, unknown> | undefined,
): TaskToolGrant | undefined {
  const tools = authority?.tools;
  const grant = Array.isArray(tools) && tools.length === 1 ? parseGrant(tools[0]) : undefined;
  const valid =
    authority?.acting_as === "service_for_user" &&
    authority.service === CONTROL_PLANE_SERVICE &&
    authority.purpose === CONNECTION_STATUS_PURPOSE &&
    authority.runtime_uid === undefined &&
    authority.version === CURRENT_TASK_AUTHORITY_CLAIMS_VERSION &&
    grant?.resource === "provider-control" &&
    grant.action === "status";
  return valid ? grant : undefined;
}

function isCurrentTaskMarker(authority: Record<string, unknown> | undefined): boolean {
  return (
    authority?.version === CURRENT_TASK_AUTHORITY_CLAIMS_VERSION && isLegacyTaskMarker(authority)
  );
}

function isLegacyTaskMarker(authority: Record<string, unknown> | undefined): boolean {
  if (
    !authority ||
    typeof authority.version !== "number" ||
    !Number.isInteger(authority.version) ||
    authority.version < 1 ||
    !nonEmptyString(authority.runtime_uid) ||
    authority.purpose !== undefined
  ) {
    return false;
  }
  if (authority.acting_as === "user") {
    return authority.service === undefined;
  }
  if (authority.acting_as === "service" || authority.acting_as === "service_for_user") {
    return nonEmptyString(authority.service);
  }
  return false;
}

function parseGrant(value: unknown): TaskToolGrant | undefined {
  const grant = record(value);
  if (
    !grant ||
    Object.keys(grant).some((key) => !["provider", "resource", "action"].includes(key))
  ) {
    return undefined;
  }
  if (
    !nonEmptyString(grant.provider) ||
    !nonEmptyString(grant.resource) ||
    !nonEmptyString(grant.action)
  ) {
    return undefined;
  }
  return {
    provider: grant.provider,
    resource: grant.resource,
    action: grant.action,
  };
}

function grantKey(grant: TaskToolGrant): string {
  return JSON.stringify([grant.provider, grant.resource, grant.action]);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
