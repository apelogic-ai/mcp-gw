import claims from "../fixtures/task-authority-hop1-v3.json";

export const TASK_AUTHORITY_CLAIM = ["ste", "ward"].join("");
export const taskClaims = claims;
export const taskAuthority = (claims as Record<string, unknown>)[TASK_AUTHORITY_CLAIM] as Record<
  string,
  unknown
>;

export function withTaskAuthority(authority: Record<string, unknown>): Record<string, unknown> {
  return { ...claims, [TASK_AUTHORITY_CLAIM]: authority };
}
