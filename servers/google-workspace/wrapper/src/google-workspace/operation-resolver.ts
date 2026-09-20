import type { ScopeRequirement } from "../../../../../shared/oauth/connection-types";
import {
  GOOGLE_WORKSPACE_TOOLS,
  isExcludedGoogleWorkspaceScope,
} from "../catalog/google-workspace";
import { GWS_GENERATED_TOOLS } from "../catalog/gws-generated";
import { classifyGovernedGwsToolAction } from "../catalog/gws-action-classification";
import type { WorkspaceToolDefinition } from "../catalog/types";
import { SEND_OPERATIONS, type VerifiedOutboundEmail } from "../../../../../shared/policy/policy";
import {
  recipientDomainsFromAddressList,
  recipientDomainsFromRawMessage,
} from "../../../../../shared/policy/outbound-email";

export interface ResolvedWorkspaceOperation {
  operation: string;
  service: string;
  actionClass: WorkspaceToolDefinition["actionClass"];
  scopeRequirement: ScopeRequirement;
  outboundEmail?: VerifiedOutboundEmail;
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
      outboundEmail: assessOutboundEmail(tool.command.join("."), args),
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
    outboundEmail: assessOutboundEmail(matched.command.join("."), args, tail),
    args,
  };
}

function assessOutboundEmail(
  operation: string,
  args: Record<string, unknown>,
  rawTail?: string[],
): VerifiedOutboundEmail | undefined {
  if (!SEND_OPERATIONS.has(operation)) return undefined;
  // By-reference sends may read a draft or source message after this check.
  if (operation !== "gmail.users.messages.send" && operation !== "gmail.+send") {
    return undefined;
  }
  const domains =
    operation === "gmail.users.messages.send"
      ? assessRawMessageSend(args, rawTail)
      : assessSendHelper(args, rawTail);
  return domains && domains.length > 0
    ? { kind: "verified", recipientDomains: domains }
    : undefined;
}

function assessRawMessageSend(
  args: Record<string, unknown>,
  rawTail?: string[],
): string[] | undefined {
  let body: unknown;
  let params: unknown;
  if (rawTail) {
    const flags = parseFlagValues(
      rawTail,
      new Set(["--json", "--params", "--format"]),
      new Set(["--dry-run"]),
    );
    if (!flags || typeof flags.get("--json") !== "string") return undefined;
    try {
      body = JSON.parse(flags.get("--json") as string) as unknown;
      params = flags.has("--params")
        ? (JSON.parse(flags.get("--params") as string) as unknown)
        : undefined;
    } catch {
      return undefined;
    }
  } else {
    if (
      Object.keys(args).some(
        (key) => !["json", "params", "format", "dryRun", "extraArgs"].includes(key),
      )
    )
      return undefined;
    if (Array.isArray(args.extraArgs) && args.extraArgs.length > 0) return undefined;
    body = args.json;
    params = args.params;
  }
  if (!isRecord(body) || Object.keys(body).some((key) => key !== "raw" && key !== "threadId")) {
    return undefined;
  }
  if (
    params !== undefined &&
    (!isRecord(params) || Object.keys(params).some((key) => key !== "userId"))
  ) {
    return undefined;
  }
  return typeof body.raw === "string" ? recipientDomainsFromRawMessage(body.raw) : undefined;
}

function assessSendHelper(args: Record<string, unknown>, rawTail?: string[]): string[] | undefined {
  if (!rawTail && Object.keys(args).some((key) => key !== "args")) return undefined;
  const tail = rawTail ?? args.args;
  if (!isStringArray(tail)) return undefined;
  const flags = parseFlagValues(
    tail,
    new Set(["--to", "--cc", "--bcc", "--subject", "--body", "--from", "--attach", "-a"]),
    new Set(["--html", "--dry-run", "--draft"]),
    new Set(["--attach", "-a"]),
  );
  if (!flags || typeof flags.get("--to") !== "string") return undefined;
  const domains: string[] = [];
  for (const name of ["--to", "--cc", "--bcc"]) {
    const value = flags.get(name);
    if (value === undefined) continue;
    if (typeof value !== "string") return undefined;
    const parsed = recipientDomainsFromAddressList(value);
    if (!parsed) return undefined;
    domains.push(...parsed);
  }
  return domains.length > 0 ? [...new Set(domains)] : undefined;
}

function parseFlagValues(
  tail: string[],
  valueFlags: ReadonlySet<string>,
  booleanFlags: ReadonlySet<string>,
  repeatableFlags: ReadonlySet<string> = new Set(),
): Map<string, string | true> | undefined {
  const flags = new Map<string, string | true>();
  for (let index = 0; index < tail.length; index += 1) {
    const flag = tail[index];
    if (!flag || (flags.has(flag) && !repeatableFlags.has(flag))) return undefined;
    if (booleanFlags.has(flag)) {
      flags.set(flag, true);
      continue;
    }
    if (!valueFlags.has(flag) || tail[index + 1] === undefined) return undefined;
    flags.set(flag, tail[index + 1] ?? "");
    index += 1;
  }
  return flags;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
