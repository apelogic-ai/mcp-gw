import type { ScopeRequirement } from "../../../../../shared/oauth/connection-types";
import {
  GOOGLE_WORKSPACE_TOOLS,
  isExcludedGoogleWorkspaceScope,
} from "../catalog/google-workspace";
import { GWS_GENERATED_TOOLS } from "../catalog/gws-generated";
import { classifyGovernedGwsToolAction } from "../catalog/gws-action-classification";
import type { WorkspaceToolDefinition } from "../catalog/types";

export interface ResolvedWorkspaceOperation {
  operation: string;
  service: string;
  actionClass: WorkspaceToolDefinition["actionClass"];
  scopeRequirement: ScopeRequirement;
  args: Record<string, unknown>;
}

const COMMANDS = new Map(
  [...GOOGLE_WORKSPACE_TOOLS, ...GWS_GENERATED_TOOLS]
    .filter((tool) => tool.command.length > 0)
    .map((tool) => [tool.command.join("\0"), tool] as const),
);
export const PINNED_GWS_OPERATIONS: ReadonlySet<string> = new Set([
  ...[...COMMANDS.values()].map((tool) => tool.command.join(".")),
  "google.oauth.start",
]);
const VALUE_FLAGS = new Set([
  "--params",
  "--json",
  "--format",
  "--sanitize",
  "--output",
  "--upload",
  "--upload-content-type",
  "--page-limit",
  "--page-delay",
]);
const BOOLEAN_FLAGS = new Set(["--dry-run", "--page-all"]);

export function resolveWorkspaceOperation(
  tool: WorkspaceToolDefinition,
  untrustedArgs: Record<string, unknown>,
  hardGuardrails: boolean,
): ResolvedWorkspaceOperation {
  const args = frozenClone(untrustedArgs);
  if (!tool.rawArgvParam) {
    const extraArgs = tool.extraArgsParam ? args[tool.extraArgsParam] : undefined;
    if (
      hardGuardrails &&
      !tool.command.some((part) => part.startsWith("+")) &&
      Array.isArray(extraArgs) &&
      extraArgs.length > 0
    ) {
      throw new Error("Extra command arguments are unavailable under hard guardrails");
    }
    return {
      operation: tool.command.join("."),
      service: tool.service,
      actionClass: tool.actionClass,
      scopeRequirement: tool.scopeRequirement ?? singletonGroups(tool.scopes),
      args,
    };
  }

  const argv = args[tool.rawArgvParam];
  if (!isStringArray(argv)) {
    throw new Error("argv must be an array of strings");
  }
  const callerScopes = tool.dynamicScopesParam ? args[tool.dynamicScopesParam] : undefined;
  if (!isStringArray(callerScopes)) {
    throw new Error("scopes must be an array of strings");
  }
  if (callerScopes.some(isExcludedGoogleWorkspaceScope)) {
    throw new Error("scopes contains an unsupported Google Workspace scope");
  }
  let matched: WorkspaceToolDefinition | undefined;
  for (let length = Math.min(argv.length, 6); length > 0; length -= 1) {
    const candidate = COMMANDS.get(argv.slice(0, length).join("\0"));
    if (candidate) {
      matched = candidate;
      break;
    }
  }
  if (!matched) throw new Error("The raw gws command is not in the pinned command catalog");
  const tail = argv.slice(matched.command.length);
  if (!matched.command.some((part) => part.startsWith("+"))) validateMethodTail(tail);

  const original = matched.scopeRequirement ?? singletonGroups(matched.scopes);
  const filtered: ScopeRequirement = {
    allOf: original.allOf.map((group) => ({
      anyOf: group.anyOf.filter((scope) => !isExcludedGoogleWorkspaceScope(scope)),
    })),
  };
  if (filtered.allOf.some((group) => group.anyOf.length === 0)) {
    throw new Error("The raw gws command requires an unsupported OAuth scope");
  }
  return {
    operation: matched.command.join("."),
    service: matched.service,
    actionClass: classifyGovernedGwsToolAction(
      matched.service,
      matched.command.slice(1).join("."),
      matched.actionClass,
    ),
    scopeRequirement: filtered,
    args,
  };
}

function validateMethodTail(tail: string[]): void {
  const seen = new Set<string>();
  for (let index = 0; index < tail.length; index += 1) {
    const flag = tail[index];
    if (!flag || seen.has(flag)) throw new Error("Raw gws flags are ambiguous");
    seen.add(flag);
    if (BOOLEAN_FLAGS.has(flag)) continue;
    if (!VALUE_FLAGS.has(flag) || tail[index + 1] === undefined) {
      throw new Error("Raw gws command contains an unsupported flag or positional argument");
    }
    index += 1;
  }
}

function singletonGroups(scopes: string[]): ScopeRequirement {
  return { allOf: scopes.map((scope) => ({ anyOf: [scope] })) };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function frozenClone(args: Record<string, unknown>): Record<string, unknown> {
  return deepFreeze(structuredClone(args));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
