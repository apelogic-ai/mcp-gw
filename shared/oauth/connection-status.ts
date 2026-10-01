import type {
  ConnectionStatus,
  ConnectionStatusV1,
  ConnectionStatusV2,
  RefreshConnectionResult,
} from "./connection-types";

export const CONNECTION_STATUS_V2_MEDIA_TYPE = "application/vnd.apelogic.connection-status.v2+json";

/** Preserve the exact status-v1 wire contract unless the caller explicitly negotiates v2. */
export function connectionStatusV1(status: ConnectionStatusV2): ConnectionStatusV1 {
  const { account, ...shared } = status;
  return {
    ...shared,
    version: "1",
    ...(account?.displayName ? { account: { displayName: account.displayName } } : {}),
  };
}

export function negotiatedConnectionStatus(
  request: Request,
  status: ConnectionStatusV2,
): ConnectionStatus {
  return acceptsConnectionStatusV2(request) ? status : connectionStatusV1(status);
}

export function negotiatedRefreshResult(
  request: Request,
  refresh: RefreshConnectionResult,
): Omit<RefreshConnectionResult, "status"> & { status: ConnectionStatus } {
  return { ...refresh, status: negotiatedConnectionStatus(request, refresh.status) };
}

export function acceptsConnectionStatusV2(request: Request): boolean {
  return (request.headers.get("accept") ?? "")
    .split(",")
    .map((value) => value.split(";", 1)[0]?.trim().toLowerCase())
    .includes(CONNECTION_STATUS_V2_MEDIA_TYPE);
}

/** Additive compatibility shape shared by the OAuth MCP tool and legacy HTTP route. */
export function googleOAuthCompatibilityStatus(status: ConnectionStatusV2) {
  return {
    connected: status.connected,
    ...(status.account ? { email: status.account.displayName } : {}),
    scopesRequired: status.requiredScopes,
    scopesGranted: status.grantedScopes,
    missingScopes: status.missingScopes,
    phase: status.phase,
    ...(status.errorCategory ? { errorCategory: status.errorCategory } : {}),
    activeCredentialPresent: status.activeCredentialPresent,
    renewalCredentialPresent: status.renewalCredentialPresent,
    activeCredentialExpiresAt: status.activeCredentialExpiresAt,
    renewalCredentialExpiresAt: status.renewalCredentialExpiresAt,
    lastAuthorizedAt: status.lastAuthorizedAt,
    lastRenewedAt: status.lastRenewedAt,
    lastValidatedAt: status.lastValidatedAt,
    statusUpdatedAt: status.statusUpdatedAt,
    capabilities: status.capabilities,
  };
}

/** Additive GitHub compatibility shape shared by its OAuth MCP tool and legacy HTTP route. */
export function githubOAuthCompatibilityStatus(status: ConnectionStatusV2, includeV2 = false) {
  const legacy = {
    connected: status.connected,
    ...(status.account?.displayName ? { email: status.account.displayName } : {}),
    scopesRequired: status.requiredScopes,
    scopesGranted: status.grantedScopes,
    missingScopes: status.missingScopes,
  };
  return includeV2
    ? {
        ...legacy,
        version: status.version,
        ...(status.account ? { account: { ...status.account, provider: "github" as const } } : {}),
      }
    : legacy;
}
