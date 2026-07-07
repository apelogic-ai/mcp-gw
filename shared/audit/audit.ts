import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";

export interface AuditEvent {
  ts: string;
  category: "tool_call" | "oauth";
  principal: string;
  status: "allow" | "deny" | "error";
  event?: string;
  tool?: string;
  argDigest?: string;
  latencyMs?: number;
  resultSize?: number;
  error?: string;
}

export interface AuditSink {
  emit(event: AuditEvent): Promise<void>;
}

const SENSITIVE_KEY_PATTERN = /token|secret|password|authorization/i;

export function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        SENSITIVE_KEY_PATTERN.test(key) ? "[redacted]" : redactValue(nested),
      ]),
    );
  }

  return value;
}

export function digestArgs(args: Record<string, unknown>): string {
  return createHash("sha256")
    .update(stableStringify(redactValue(args)))
    .digest("hex");
}

export class InMemoryAuditSink implements AuditSink {
  readonly events: AuditEvent[] = [];

  emit(event: AuditEvent): Promise<void> {
    this.events.push({ ...event });
    return Promise.resolve();
  }
}

export class JsonlAuditSink implements AuditSink {
  constructor(private readonly path: string) {}

  async emit(event: AuditEvent): Promise<void> {
    await appendFile(this.path, `${JSON.stringify(event)}\n`, "utf8");
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
