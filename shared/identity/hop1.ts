import { createLocalJWKSet, jwtVerify, type JWTPayload, type JWK } from "jose";

export interface IssuerProfile {
  name: string;
  issuer: string;
  audiences: string[];
  emailClaim: string;
  subjectClaim?: string;
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

export class Hop1ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Hop1ValidationError";
  }
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
    });

    return identityFromClaims(result.payload, profile);
  } catch (error) {
    if (error instanceof Hop1ValidationError) {
      throw error;
    }

    throw new Hop1ValidationError(error instanceof Error ? error.message : "JWT validation failed");
  }
}

export async function validateHop1JwtForIssuers(
  token: string,
  issuers: TrustedIssuer[],
): Promise<Hop1Identity> {
  const errors: string[] = [];
  for (const trusted of issuers) {
    try {
      return await validateHop1Jwt(token, trusted.profile, trusted.jwks);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  throw new Hop1ValidationError(
    `JWT did not validate against any trusted issuer: ${errors[0] ?? "no issuers configured"}`,
  );
}

function identityFromClaims(claims: JWTPayload, profile: IssuerProfile): Hop1Identity {
  const subjectClaim = profile.subjectClaim ?? "sub";
  const subject = claimAsString(claims, subjectClaim);
  const email = claimAsString(claims, profile.emailClaim);

  if (!subject) {
    throw new Hop1ValidationError(`JWT missing required subject claim: ${subjectClaim}`);
  }

  if (!email) {
    throw new Hop1ValidationError(`JWT missing required email claim: ${profile.emailClaim}`);
  }

  if (!claims.iss) {
    throw new Hop1ValidationError("JWT missing issuer");
  }

  return {
    profile: profile.name,
    issuer: claims.iss,
    subject,
    email,
    claims,
  };
}

function claimAsString(claims: JWTPayload, claimName: string): string | undefined {
  const value = claims[claimName];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
