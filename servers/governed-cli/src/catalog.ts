import { parse } from "yaml";

export const CLI_DECISIONS_SCHEMA = "mcp-gateway.cli-decisions/v1" as const;
export const COMMAND_CLASSES = ["read", "write", "destructive"] as const;
export type CommandClass = (typeof COMMAND_CLASSES)[number];

export interface CliCommandDecision {
  class: CommandClass;
}

export interface CliDecisionCatalog {
  schemaVersion: typeof CLI_DECISIONS_SCHEMA;
  cli: string;
  commands: Readonly<Record<string, CliCommandDecision>>;
}

export function parseCliDecisionCatalog(source: string): CliDecisionCatalog {
  const value = parse(source) as unknown;
  if (!isRecord(value) || value.schemaVersion !== CLI_DECISIONS_SCHEMA) {
    throw new Error(`CLI decisions must use schemaVersion ${CLI_DECISIONS_SCHEMA}`);
  }
  assertOnlyKeys(value, ["schemaVersion", "cli", "commands"], "CLI decisions");
  if (!nonEmptyString(value.cli)) throw new Error("CLI decisions cli must be a non-empty string");
  if (!isRecord(value.commands) || Object.keys(value.commands).length === 0) {
    throw new Error("CLI decisions commands must be a non-empty mapping");
  }

  const commands: Record<string, CliCommandDecision> = {};
  for (const [command, raw] of Object.entries(value.commands)) {
    if (!nonEmptyString(command) || !isRecord(raw)) {
      throw new Error("CLI decision command names and values must be non-empty mappings");
    }
    assertOnlyKeys(raw, ["class"], `CLI decision ${command}`);
    if (!COMMAND_CLASSES.includes(raw.class as CommandClass)) {
      throw new Error(`CLI decision ${command} has an invalid class`);
    }
    commands[command] = { class: raw.class as CommandClass };
  }
  return { schemaVersion: CLI_DECISIONS_SCHEMA, cli: value.cli, commands };
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: string[], name: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${name} contains unknown field ${unknown}`);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
