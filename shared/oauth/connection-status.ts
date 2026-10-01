import type { ConnectionStatusV2 } from "./connection-types";

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
export function githubOAuthCompatibilityStatus(status: ConnectionStatusV2) {
  return {
    version: status.version,
    connected: status.connected,
    ...(status.account ? { account: { ...status.account, provider: "github" as const } } : {}),
    ...(status.account?.displayName ? { email: status.account.displayName } : {}),
    scopesRequired: status.requiredScopes,
    scopesGranted: status.grantedScopes,
    missingScopes: status.missingScopes,
  };
}
