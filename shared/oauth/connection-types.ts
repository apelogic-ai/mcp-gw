import type { Hop1Identity } from "../identity/hop1";
import type { OAuthProvider } from "./store";

export type ConnectionPhase =
  | "disconnected"
  | "authorizing"
  | "connected"
  | "renewing"
  | "reauthorization_required"
  | "revocation_pending"
  | "disconnected_with_provider_cleanup_pending"
  | "unavailable";

export type LifecycleErrorCategory =
  | "transient_provider_failure"
  | "invalid_active_credential"
  | "invalid_renewal_credential"
  | "renewal_expired"
  | "authorization_denied"
  | "identity_mismatch"
  | "insufficient_scope"
  | "provider_configuration_error"
  | "malformed_provider_response"
  | "persistence_failure"
  | "generation_conflict";

export type ProviderRevocationResult =
  "revoked" | "already_absent" | "not_supported" | "retryable_failure" | "permanent_failure";

export type RevocationState = "none" | "pending" | "complete" | "permanent_failure";

export interface ProviderConnectionCapabilities {
  interactiveAuthorization: boolean;
  activeCredentialExpiry: boolean;
  automaticRenewal: boolean;
  manualRenewal: boolean;
  rotatingRenewalCredential: boolean;
  providerValidation: boolean;
  providerRevocation: boolean;
  scopeReporting: boolean;
  identityVerification: boolean;
}

/** Secret provider data. Instances must never be logged, audited, or returned by HTTP APIs. */
export interface ProviderCredentialEnvelope {
  activeCredential?: string;
  renewalCredential?: string;
  [providerField: string]: unknown;
}

export interface DecryptedCredentialGeneration {
  provider: OAuthProvider;
  generation: number;
  credential: ProviderCredentialEnvelope;
  activeCredentialExpiresAt?: Date;
  renewalCredentialExpiresAt?: Date;
  grantedScopes: string[];
}

export interface IssuedCredentialGeneration {
  credential: ProviderCredentialEnvelope;
  displayAccountIdentity: string;
  grantedScopes: string[];
  activeCredentialExpiresAt?: Date;
  renewalCredentialExpiresAt?: Date;
  validatedAt?: Date;
}

export interface RenewedCredentialGeneration {
  credential: ProviderCredentialEnvelope;
  grantedScopes?: string[];
  activeCredentialExpiresAt?: Date;
  renewalCredentialExpiresAt?: Date;
  validatedAt?: Date;
}

export interface ValidatedProviderIdentity {
  displayAccountIdentity: string;
}

export interface StartAuthorizationRequest {
  identity: Hop1Identity;
  scopes: string[];
  state: string;
}

export interface AuthorizationContinuation {
  authorizationUrl: string;
}

export interface CompleteAuthorizationRequest {
  code: string;
  expectedPrincipal: Hop1Identity;
  requestedScopes: string[];
}

export interface DownstreamConnectionAdapter {
  readonly providerId: OAuthProvider;
  readonly capabilities: ProviderConnectionCapabilities;
  hasRequiredScopes?(granted: string[], required: string[]): boolean;
  startAuthorization?(request: StartAuthorizationRequest): Promise<AuthorizationContinuation>;
  completeAuthorization?(
    request: CompleteAuthorizationRequest,
  ): Promise<IssuedCredentialGeneration>;
  renew?(credential: DecryptedCredentialGeneration): Promise<RenewedCredentialGeneration>;
  validateIdentity?(
    credential: DecryptedCredentialGeneration,
    expectedPrincipal: Hop1Identity,
  ): Promise<ValidatedProviderIdentity>;
  revoke?(credential: DecryptedCredentialGeneration): Promise<ProviderRevocationResult>;
}

export class ProviderLifecycleError extends Error {
  constructor(
    message: string,
    public readonly category: LifecycleErrorCategory,
  ) {
    super(message);
    this.name = "ProviderLifecycleError";
  }
}

export function lifecycleErrorRequiresReauthorization(error: unknown): boolean {
  if (!(error instanceof ProviderLifecycleError)) return false;
  return (
    error.category === "invalid_active_credential" ||
    error.category === "invalid_renewal_credential" ||
    error.category === "renewal_expired" ||
    error.category === "identity_mismatch" ||
    error.category === "insufficient_scope"
  );
}

export interface ConnectionRecord {
  provider: OAuthProvider;
  hop1Issuer: string;
  hop1Subject: string;
  displayAccountIdentity: string;
  encryptedCredentialEnvelope?: string;
  credentialSchemaVersion?: number;
  generation: number;
  requiredScopes: string[];
  grantedScopes: string[];
  activeCredentialPresent: boolean;
  renewalCredentialPresent: boolean;
  activeCredentialExpiresAt?: Date;
  renewalCredentialExpiresAt?: Date;
  lastAuthorizedAt?: Date;
  lastRenewedAt?: Date;
  lastValidatedAt?: Date;
  localDisabledAt?: Date;
  phase: ConnectionPhase;
  revocationState: RevocationState;
  revocationStartedAt?: Date;
  revocationCompletedAt?: Date;
  lifecycleErrorCategory?: LifecycleErrorCategory;
  createdAt: Date;
  updatedAt: Date;
  /** Only for one-release compatibility with old readers and writers. */
  encryptedLegacyCredential: string;
}

export interface ConnectionStatusV1 {
  version: "1";
  provider: OAuthProvider;
  phase: ConnectionPhase;
  connected: boolean;
  account?: { displayName: string };
  requiredScopes: string[];
  grantedScopes: string[];
  missingScopes: string[];
  activeCredentialExpiresAt: string | null;
  renewalCredentialExpiresAt: string | null;
  lastAuthorizedAt: string | null;
  lastRenewedAt: string | null;
  lastValidatedAt: string | null;
  capabilities: ProviderConnectionCapabilities;
  errorCategory?: LifecycleErrorCategory;
}

export interface RefreshConnectionResult {
  result: "refreshed" | "already_fresh" | "refresh_not_supported" | "reauthorization_required";
  status: ConnectionStatusV1;
}
