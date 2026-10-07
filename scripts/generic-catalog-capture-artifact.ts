import { createHash } from "node:crypto";

export function catalogCaptureSha256(value: string | unknown): string {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  const canonical = JSON.stringify(canonicalValue(parsed));
  return createHash("sha256").update(canonical).digest("hex");
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalValue(entry)]),
  );
}
