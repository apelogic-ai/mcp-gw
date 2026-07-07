import { createHash, randomBytes } from "node:crypto";

export function generateOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

export function hashState(state: string): string {
  return createHash("sha256").update(state).digest("base64url");
}
