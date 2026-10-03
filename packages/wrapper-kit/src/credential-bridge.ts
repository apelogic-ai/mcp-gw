export type CredentialBridgeMode = "per_user_oauth" | "static_secret" | "token_exchange";

export interface CredentialBridge<Identity, Requirement, Credential> {
  readonly mode: CredentialBridgeMode;
  resolve(identity: Identity, requirement: Requirement): Promise<Credential>;
  recover?(
    identity: Identity,
    requirement: Requirement,
    rejectedCredential: Credential,
  ): Promise<Credential>;
  revoke?(identity: Identity, credential: Credential): Promise<void>;
}

export interface CreateCredentialBridgeOptions<Identity, Requirement, Credential> {
  mode: CredentialBridgeMode;
  resolve(identity: Identity, requirement: Requirement): Promise<Credential>;
  recover?(
    identity: Identity,
    requirement: Requirement,
    rejectedCredential: Credential,
  ): Promise<Credential>;
  revoke?(identity: Identity, credential: Credential): Promise<void>;
}

/**
 * Provider adapters own credential storage and renewal. The bridge exposes only
 * provider credentials and never receives the caller's Authorization header.
 */
export function createCredentialBridge<Identity, Requirement, Credential>(
  options: CreateCredentialBridgeOptions<Identity, Requirement, Credential>,
): CredentialBridge<Identity, Requirement, Credential> {
  return options;
}
