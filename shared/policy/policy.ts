import { redactValue } from "../audit/audit";
import { parse as parseYaml } from "yaml";
import type { ScopeRequirement } from "../oauth/connection-types";
import { canonicalPolicyDomain, domainIsAllowed } from "./outbound-email";

export interface VerifiedOutboundEmail {
  kind: "verified";
  /** Domains only; full recipient addresses are never sent to policy or telemetry. */
  recipientDomains: string[];
}

export type PolicyActionClass = "read" | "write" | "destructive";

export interface ToolPolicyInput {
  principal: string;
  tokenClaims: Record<string, unknown>;
  tool: string;
  /** Server-resolved provider operation, never asserted by the caller. */
  operation?: string;
  service: string;
  actionClass: PolicyActionClass;
  scopes: string[];
  scopeRequirement?: ScopeRequirement;
  outboundEmail?: VerifiedOutboundEmail;
  args: Record<string, unknown>;
}

export type PolicyDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string; ruleId?: string }
  | { kind: "approval_required"; reason: string; ruleId?: string };

export interface ToolPolicy {
  readonly hardGuardrails?: boolean;
  decide(input: ToolPolicyInput): Promise<PolicyDecision>;
}

export class AllowAllPolicy implements ToolPolicy {
  decide(input: ToolPolicyInput): Promise<PolicyDecision> {
    void input;
    return Promise.resolve({ kind: "allow" });
  }
}

export class CompositePolicy implements ToolPolicy {
  readonly hardGuardrails: boolean;

  constructor(private readonly policies: ToolPolicy[]) {
    this.hardGuardrails = policies.some((policy) => policy.hardGuardrails === true);
  }

  async decide(input: ToolPolicyInput): Promise<PolicyDecision> {
    let approval: PolicyDecision | undefined;

    for (const policy of this.policies) {
      const decision = await policy.decide(input);
      if (decision.kind === "deny") {
        return decision;
      }
      if (decision.kind === "approval_required") {
        approval = decision;
      }
    }

    return approval ?? { kind: "allow" };
  }
}

export interface YamlPolicyConfig {
  default?: YamlPolicyEffect;
  rules?: YamlPolicyRule[];
  guardrails?: {
    deniedOperations?: string[];
    outboundEmail?: { allowedRecipientDomains: string[] };
  };
}

export type YamlPolicyEffect = "allow" | "deny" | "approval_required";

export interface YamlPolicyRule {
  id?: string;
  effect: YamlPolicyEffect;
  reason?: string;
  match?: YamlPolicyMatch;
}

export interface YamlPolicyMatch {
  principal?: string | string[];
  principals?: string[];
  tool?: string | string[];
  tools?: string[];
  service?: string | string[];
  services?: string[];
  operation?: string | string[];
  operations?: string[];
  actionClass?: PolicyActionClass | PolicyActionClass[];
  actionClasses?: PolicyActionClass[];
  scope?: string | string[];
  scopes?: string[];
}

export class YamlPolicy implements ToolPolicy {
  readonly hardGuardrails: boolean;
  private readonly defaultEffect: YamlPolicyEffect;
  private readonly rules: YamlPolicyRule[];
  private readonly deniedOperations: Set<string>;
  private readonly allowedRecipientDomains: Set<string>;

  constructor(config: YamlPolicyConfig) {
    this.defaultEffect = config.default ?? "allow";
    this.rules = config.rules ?? [];
    this.deniedOperations = new Set(config.guardrails?.deniedOperations ?? []);
    this.allowedRecipientDomains = new Set(
      config.guardrails?.outboundEmail?.allowedRecipientDomains ?? [],
    );
    this.hardGuardrails = this.deniedOperations.size > 0 || this.allowedRecipientDomains.size > 0;
    validateYamlPolicyEffect(this.defaultEffect, "default");
    this.rules.forEach(validateYamlPolicyRule);
  }

  decide(input: ToolPolicyInput): Promise<PolicyDecision> {
    if (this.hardGuardrails && !input.operation) {
      return Promise.resolve({
        kind: "deny",
        reason: "Operation cannot be classified under global policy",
        ruleId: "guardrails.unclassified_operation",
      });
    }
    if (input.operation && this.deniedOperations.has(input.operation)) {
      return Promise.resolve({
        kind: "deny",
        reason: "Operation disabled by global policy",
        ruleId: "guardrails.denied_operations",
      });
    }
    if (
      this.allowedRecipientDomains.size > 0 &&
      input.operation &&
      SEND_OPERATIONS.has(input.operation)
    ) {
      if (
        input.outboundEmail?.kind !== "verified" ||
        input.outboundEmail.recipientDomains.length === 0
      ) {
        return Promise.resolve({
          kind: "deny",
          reason: "Outbound email recipients cannot be verified",
          ruleId: "guardrails.outbound_email_opaque",
        });
      }
      if (
        input.outboundEmail.recipientDomains.some(
          (recipient) =>
            ![...this.allowedRecipientDomains].some((allowed) =>
              domainIsAllowed(recipient, allowed),
            ),
        )
      ) {
        return Promise.resolve({
          kind: "deny",
          reason: "Outbound email recipient domain is not allowed",
          ruleId: "guardrails.outbound_email_domain",
        });
      }
    }
    for (const [index, rule] of this.rules.entries()) {
      if (matchesRule(rule, input)) {
        return Promise.resolve(
          decisionForEffect(rule.effect, rule.reason, rule.id ?? `yaml.rule.${String(index + 1)}`),
        );
      }
    }

    return Promise.resolve(
      decisionForEffect(
        this.defaultEffect,
        `YAML policy default ${this.defaultEffect}`,
        "yaml.default",
      ),
    );
  }
}

export function createYamlPolicyFromString(
  content: string,
  knownOperations?: ReadonlySet<string>,
): ToolPolicy {
  const parsed: unknown = parseYaml(content);
  if (!isRecord(parsed)) {
    throw new Error("YAML policy must be an object");
  }

  const config = parseYamlPolicyConfig(parsed);
  for (const operation of config.guardrails?.deniedOperations ?? []) {
    if (knownOperations && !knownOperations.has(operation)) {
      throw new Error(`Unknown guardrail operation: ${operation}`);
    }
  }
  return new YamlPolicy(config);
}

export interface OpaPolicyRequest {
  input: ToolPolicyInput;
}

export interface OpaPolicyResponse {
  result?: {
    allow?: boolean;
    approval_required?: boolean;
    reason?: string;
  };
}

export type OpaPolicyEvaluator = (request: OpaPolicyRequest) => Promise<OpaPolicyResponse>;
export type PolicyFetch = (url: string, init?: RequestInit) => Promise<Response>;

export class OpaPolicyAdapter implements ToolPolicy {
  constructor(private readonly evaluate: OpaPolicyEvaluator) {}

  async decide(input: ToolPolicyInput): Promise<PolicyDecision> {
    const response = await this.evaluate({
      input: {
        ...input,
        args:
          input.operation && SEND_OPERATIONS.has(input.operation)
            ? {}
            : (redactValue(input.args) as Record<string, unknown>),
      },
    });
    const result = response.result;

    if (result?.allow) {
      return { kind: "allow" };
    }

    const reason = result?.reason ?? "policy denied";
    if (result?.approval_required) {
      return { kind: "approval_required", reason };
    }

    return { kind: "deny", reason };
  }
}

export function createOpaPolicyFromUrl(url: string, fetchImpl: PolicyFetch = fetch): ToolPolicy {
  return new OpaPolicyAdapter(async (request) => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      return {
        result: {
          allow: false,
          reason: `OPA policy request failed: ${String(response.status)}`,
        },
      };
    }

    return (await response.json()) as OpaPolicyResponse;
  });
}

function parseYamlPolicyConfig(record: Record<string, unknown>): YamlPolicyConfig {
  const defaultEffect = optionalString(record.default, "default") as YamlPolicyEffect | undefined;
  const rulesValue = record.rules;
  if (rulesValue !== undefined && !Array.isArray(rulesValue)) {
    throw new Error("rules must be an array");
  }

  return {
    default: defaultEffect,
    rules: rulesValue?.map(parseYamlPolicyRule),
    guardrails: parseYamlGuardrails(record.guardrails),
  };
}

function parseYamlGuardrails(value: unknown): YamlPolicyConfig["guardrails"] {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("guardrails must be an object");
  for (const key of Object.keys(value)) {
    if (key !== "deniedOperations" && key !== "outboundEmail") {
      throw new Error(`Unsupported guardrails field: ${key}`);
    }
  }
  const deniedOperations = optionalStringArray(
    value.deniedOperations,
    "guardrails.deniedOperations",
  );
  for (const operation of deniedOperations ?? []) {
    if (!/^[a-z][a-z0-9]*(?:\.\+?[a-z][a-zA-Z0-9]*){1,5}$/.test(operation)) {
      throw new Error("guardrails.deniedOperations contains an invalid operation");
    }
  }
  let outboundEmail: { allowedRecipientDomains: string[] } | undefined;
  if (value.outboundEmail !== undefined) {
    if (!isRecord(value.outboundEmail))
      throw new Error("guardrails.outboundEmail must be an object");
    for (const key of Object.keys(value.outboundEmail)) {
      if (key !== "allowedRecipientDomains") {
        throw new Error(`Unsupported guardrails.outboundEmail field: ${key}`);
      }
    }
    const domains = optionalStringArray(
      value.outboundEmail.allowedRecipientDomains,
      "guardrails.outboundEmail.allowedRecipientDomains",
    );
    if (
      !domains ||
      domains.length === 0 ||
      domains.some((domain) => !canonicalPolicyDomain(domain))
    ) {
      throw new Error(
        "guardrails.outboundEmail.allowedRecipientDomains must contain canonical domains",
      );
    }
    outboundEmail = { allowedRecipientDomains: domains };
  }
  return { deniedOperations, outboundEmail };
}

/** Indirect mail-producing operations whose eventual recipient set is not fixed by this call. */
export const OPAQUE_MAIL_OPERATIONS: ReadonlySet<string> = new Set([
  "script.scripts.run",
  "gmail.users.settings.forwardingAddresses.create",
  "gmail.users.settings.updateAutoForwarding",
  "gmail.users.settings.filters.create",
  "gmail.users.settings.updateVacation",
  "gmail.users.settings.sendAs.create",
  "gmail.users.settings.sendAs.verify",
]);

/** Every pinned route that can directly or indirectly produce outgoing mail. */
export const SEND_OPERATIONS: ReadonlySet<string> = new Set([
  "gmail.users.messages.send",
  "gmail.users.drafts.send",
  "gmail.+send",
  "gmail.+reply",
  "gmail.+reply-all",
  "gmail.+forward",
  ...OPAQUE_MAIL_OPERATIONS,
]);

function parseYamlPolicyRule(value: unknown, index: number): YamlPolicyRule {
  if (!isRecord(value)) {
    throw new Error(`YAML policy rule ${String(index)} must be an object`);
  }

  const effect = requiredString(value.effect, `rules[${String(index)}].effect`);
  validateYamlPolicyEffect(effect, `rules[${String(index)}].effect`);

  return {
    id: optionalString(value.id, `rules[${String(index)}].id`),
    effect,
    reason: optionalString(value.reason, `rules[${String(index)}].reason`),
    match: parseYamlPolicyMatch(value.match, index),
  };
}

function parseYamlPolicyMatch(value: unknown, ruleIndex: number): YamlPolicyMatch | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`rules[${String(ruleIndex)}].match must be an object`);
  }

  return {
    principal: optionalStringOrStringArray(
      value.principal,
      `rules[${String(ruleIndex)}].match.principal`,
    ),
    principals: optionalStringArray(
      value.principals,
      `rules[${String(ruleIndex)}].match.principals`,
    ),
    tool: optionalStringOrStringArray(value.tool, `rules[${String(ruleIndex)}].match.tool`),
    tools: optionalStringArray(value.tools, `rules[${String(ruleIndex)}].match.tools`),
    service: optionalStringOrStringArray(
      value.service,
      `rules[${String(ruleIndex)}].match.service`,
    ),
    services: optionalStringArray(value.services, `rules[${String(ruleIndex)}].match.services`),
    operation: optionalStringOrStringArray(
      value.operation,
      `rules[${String(ruleIndex)}].match.operation`,
    ),
    operations: optionalStringArray(
      value.operations,
      `rules[${String(ruleIndex)}].match.operations`,
    ),
    actionClass: optionalActionClassOrArray(
      value.actionClass,
      `rules[${String(ruleIndex)}].match.actionClass`,
    ),
    actionClasses: optionalActionClassArray(
      value.actionClasses,
      `rules[${String(ruleIndex)}].match.actionClasses`,
    ),
    scope: optionalStringOrStringArray(value.scope, `rules[${String(ruleIndex)}].match.scope`),
    scopes: optionalStringArray(value.scopes, `rules[${String(ruleIndex)}].match.scopes`),
  };
}

function validateYamlPolicyRule(rule: YamlPolicyRule, index: number): void {
  validateYamlPolicyEffect(rule.effect, `rules[${String(index)}].effect`);
  if (rule.id && !/^[a-z][a-z0-9_.-]{0,63}$/.test(rule.id)) {
    throw new Error(`rules[${String(index)}].id must be a stable low-cardinality identifier`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, path: string): string {
  const result = optionalString(value, path);
  if (result === undefined) {
    throw new Error(`${path} must be a string`);
  }

  return result;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${path} must be a string`);
  }

  return value;
}

function optionalStringArray(value: unknown, path: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${path} must be a string array`);
  }

  return value as string[];
}

function optionalStringOrStringArray(value: unknown, path: string): string | string[] | undefined {
  if (value === undefined || typeof value === "string") {
    return value;
  }

  return optionalStringArray(value, path);
}

function optionalActionClassArray(value: unknown, path: string): PolicyActionClass[] | undefined {
  const result = optionalStringArray(value, path);
  result?.forEach((actionClass) => validateActionClass(actionClass, path));
  return result as PolicyActionClass[] | undefined;
}

function optionalActionClassOrArray(
  value: unknown,
  path: string,
): PolicyActionClass | PolicyActionClass[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    validateActionClass(value, path);
    return value;
  }

  return optionalActionClassArray(value, path);
}

function validateActionClass(
  actionClass: string,
  path: string,
): asserts actionClass is PolicyActionClass {
  if (actionClass !== "read" && actionClass !== "write" && actionClass !== "destructive") {
    throw new Error(`${path} must be read, write, or destructive`);
  }
}

function validateYamlPolicyEffect(
  effect: string | undefined,
  path: string,
): asserts effect is YamlPolicyEffect {
  if (effect !== "allow" && effect !== "deny" && effect !== "approval_required") {
    throw new Error(`${path} must be allow, deny, or approval_required`);
  }
}

function matchesRule(rule: YamlPolicyRule, input: ToolPolicyInput): boolean {
  const match = rule.match;
  if (!match) {
    return true;
  }

  return (
    matchesAny(input.principal, [...values(match.principal), ...values(match.principals)]) &&
    matchesAny(input.tool, [...values(match.tool), ...values(match.tools)]) &&
    matchesAny(input.service, [...values(match.service), ...values(match.services)]) &&
    matchesAny(input.operation ?? "", [...values(match.operation), ...values(match.operations)]) &&
    matchesAny(input.actionClass, [...values(match.actionClass), ...values(match.actionClasses)]) &&
    matchesScopes(input.scopes, [...values(match.scope), ...values(match.scopes)])
  );
}

function values<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function matchesAny<T extends string>(actual: T, allowed: T[]): boolean {
  return allowed.length === 0 || allowed.includes(actual);
}

function matchesScopes(actualScopes: string[], requiredScopes: string[]): boolean {
  return (
    requiredScopes.length === 0 ||
    requiredScopes.some((requiredScope) => actualScopes.includes(requiredScope))
  );
}

function decisionForEffect(
  effect: YamlPolicyEffect,
  reason?: string,
  ruleId?: string,
): PolicyDecision {
  if (effect === "allow") {
    return { kind: "allow" };
  }

  return {
    kind: effect,
    reason: reason ?? `YAML policy ${effect}`,
    ...(ruleId ? { ruleId } : {}),
  };
}
