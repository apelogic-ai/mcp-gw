import { createLocalJWKSet, errors, jwtVerify, type JWTPayload, type JWK } from "jose";

export const HOP1_SUPPORTED_ALGORITHMS = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "EdDSA",
] as const;

export type Hop1Algorithm = (typeof HOP1_SUPPORTED_ALGORITHMS)[number];

export interface IssuerProfile {
  name: string;
  issuer: string;
  audiences: string[];
  allowedAlgorithms: Hop1Algorithm[];
  emailClaim: string;
  subjectClaim?: string;
}

export interface Hop1IssuerConfig extends IssuerProfile {
  jwksUrl: string;
  introspectionUrl?: string;
  introspectionClientCredential?: string;
}

export interface Hop1Identity {
  profile: string;
  issuer: string;
  subject: string;
  email: string;
  claims: JWTPayload;
}

export interface TrustedIssuer {
  profile: IssuerProfile;
  jwks: JWK[];
}

export const HOP1_FAILURE_CLASSIFICATIONS = [
  "missing_bearer",
  "malformed_token",
  "untrusted_issuer",
  "jwks_unavailable",
  "unknown_key",
  "invalid_signature",
  "invalid_audience",
  "expired_token",
  "missing_subject",
  "missing_email",
  "inactive_token",
  "introspection_unavailable",
] as const;

export type Hop1FailureClassification = (typeof HOP1_FAILURE_CLASSIFICATIONS)[number];
export type Hop1FailureReporter = (classification: Hop1FailureClassification) => void;

export function reportHop1AuthenticationFailure(classification: Hop1FailureClassification): void {
  console.warn(`mcp_authentication_failed classification=${classification}`);
}

export function validateHop1IssuerProfiles<T extends Hop1IssuerConfig>(profiles: T[]): T[] {
  if (profiles.length === 0) {
    throw new Error("At least one HOP-1 issuer profile is required");
  }

  const names = new Set<string>();
  const issuers = new Set<string>();
  for (const [index, profile] of profiles.entries()) {
    const prefix = `HOP-1 issuer profile ${String(index)}`;
    requireNonEmpty(profile.name, `${prefix}.name`);
    requireHttpUrl(profile.issuer, `${prefix}.issuer`);
    requireHttpUrl(profile.jwksUrl, `${prefix}.jwksUrl`);
    requireUniqueNonEmptyStrings(profile.audiences, `${prefix}.audiences`);
    requireUniqueNonEmptyStrings(profile.allowedAlgorithms, `${prefix}.allowedAlgorithms`);
    requireNonEmpty(profile.emailClaim, `${prefix}.emailClaim`);
    if (profile.subjectClaim !== undefined) {
      requireNonEmpty(profile.subjectClaim, `${prefix}.subjectClaim`);
    }
    if (profile.introspectionUrl !== undefined) {
      requireHttpUrl(profile.introspectionUrl, `${prefix}.introspectionUrl`);
    }

    if (names.has(profile.name)) {
      throw new Error(`Duplicate HOP-1 issuer profile name: ${profile.name}`);
    }
    if (issuers.has(profile.issuer)) {
      throw new Error(`Duplicate HOP-1 issuer URL: ${profile.issuer}`);
    }
    names.add(profile.name);
    issuers.add(profile.issuer);
  }

  return profiles;
}

export function normalizedHop1Claims(identity: Hop1Identity): JWTPayload {
  return {
    ...identity.claims,
    email: identity.email,
    sub: identity.subject,
  };
}

export class Hop1ValidationError extends Error {
  readonly classification: Hop1FailureClassification;

  constructor(message: string, classification: Hop1FailureClassification = "malformed_token") {
    super(message);
    this.name = "Hop1ValidationError";
    this.classification = classification;
  }
}

export function classifyHop1ValidationFailure(error: unknown): Hop1FailureClassification {
  return error instanceof Hop1ValidationError ? error.classification : "malformed_token";
}

export async function validateHop1Jwt(
  token: string,
  profile: IssuerProfile,
  jwks: JWK[],
): Promise<Hop1Identity> {
  try {
    const keySet = createLocalJWKSet({
      keys: jwks,
    });

    const result = await jwtVerify(token, keySet, {
      issuer: profile.issuer,
      audience: profile.audiences,
      algorithms: profile.allowedAlgorithms,
    });

    return identityFromClaims(result.payload, profile);
  } catch (error) {
    if (error instanceof Hop1ValidationError) {
      throw error;
    }

    throw new Hop1ValidationError(
      error instanceof Error ? error.message : "JWT validation failed",
      classifyJoseFailure(error),
    );
  }
}

export async function validateHop1JwtForIssuers(
  token: string,
  issuers: TrustedIssuer[],
): Promise<Hop1Identity> {
  const validationErrors: Hop1ValidationError[] = [];
  for (const trusted of issuers) {
    try {
      return await validateHop1Jwt(token, trusted.profile, trusted.jwks);
    } catch (error) {
      validationErrors.push(
        error instanceof Hop1ValidationError
          ? error
          : new Hop1ValidationError(error instanceof Error ? error.message : String(error)),
      );
    }
  }

  throw new Hop1ValidationError(
    `JWT did not validate against any trusted issuer: ${validationErrors[0]?.message ?? "no issuers configured"}`,
    validationErrors[0]?.classification ?? "untrusted_issuer",
  );
}

function identityFromClaims(claims: JWTPayload, profile: IssuerProfile): Hop1Identity {
  const subjectClaim = profile.subjectClaim ?? "sub";
  const subject = claimAsString(claims, subjectClaim);
  const email = claimAsString(claims, profile.emailClaim);

  if (claims.exp === undefined) {
    throw new Hop1ValidationError("JWT missing expiration claim: exp", "malformed_token");
  }

  if (!subject) {
    throw new Hop1ValidationError(
      `JWT missing required subject claim: ${subjectClaim}`,
      "missing_subject",
    );
  }

  if (!email) {
    throw new Hop1ValidationError(
      `JWT missing required email claim: ${profile.emailClaim}`,
      "missing_email",
    );
  }

  if (!claims.iss) {
    throw new Hop1ValidationError("JWT missing issuer", "untrusted_issuer");
  }

  return {
    profile: profile.name,
    issuer: claims.iss,
    subject,
    email,
    claims,
  };
}

function classifyJoseFailure(error: unknown): Hop1FailureClassification {
  if (error instanceof errors.JWTExpired) {
    return "expired_token";
  }
  if (error instanceof errors.JWTClaimValidationFailed) {
    if (error.claim === "aud") {
      return "invalid_audience";
    }
    if (error.claim === "iss") {
      return "untrusted_issuer";
    }
  }
  if (error instanceof errors.JWKSNoMatchingKey) {
    return "unknown_key";
  }
  if (error instanceof errors.JWSSignatureVerificationFailed) {
    return "invalid_signature";
  }
  return "malformed_token";
}

function claimAsString(claims: JWTPayload, claimName: string): string | undefined {
  const value = claims[claimName];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requireNonEmpty(value: string, name: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
}

function requireHttpUrl(value: string, name: string): void {
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname) {
      throw new Error("unsupported URL");
    }
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) URL`);
  }
}

function requireUniqueNonEmptyStrings(values: readonly string[], name: string): void {
  if (values.length === 0 || values.some((value) => value.trim().length === 0)) {
    throw new Error(`${name} must be a non-empty array of non-empty strings`);
  }
  if (new Set(values).size !== values.length) {
    throw new Error(`${name} must not contain duplicates`);
  }
}
