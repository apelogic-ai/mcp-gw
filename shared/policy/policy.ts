import { redactValue } from "../audit/audit";
import { parse as parseYaml } from "yaml";

export type PolicyActionClass = "read" | "write" | "destructive";

export interface ToolPolicyInput {
  principal: string;
  tool: string;
  service: string;
  actionClass: PolicyActionClass;
  scopes: string[];
  args: Record<string, unknown>;
}

export type PolicyDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "approval_required"; reason: string };

export interface ToolPolicy {
  decide(input: ToolPolicyInput): Promise<PolicyDecision>;
}

export class AllowAllPolicy implements ToolPolicy {
  decide(input: ToolPolicyInput): Promise<PolicyDecision> {
    void input;
    return Promise.resolve({ kind: "allow" });
  }
}

export class CompositePolicy implements ToolPolicy {
  constructor(private readonly policies: ToolPolicy[]) {}

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
}

export type YamlPolicyEffect = "allow" | "deny" | "approval_required";

export interface YamlPolicyRule {
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
  actionClass?: PolicyActionClass | PolicyActionClass[];
  actionClasses?: PolicyActionClass[];
  scope?: string | string[];
  scopes?: string[];
}

export class YamlPolicy implements ToolPolicy {
  private readonly defaultEffect: YamlPolicyEffect;
  private readonly rules: YamlPolicyRule[];

  constructor(config: YamlPolicyConfig) {
    this.defaultEffect = config.default ?? "allow";
    this.rules = config.rules ?? [];
    validateYamlPolicyEffect(this.defaultEffect, "default");
    this.rules.forEach(validateYamlPolicyRule);
  }

  decide(input: ToolPolicyInput): Promise<PolicyDecision> {
    for (const rule of this.rules) {
      if (matchesRule(rule, input)) {
        return Promise.resolve(decisionForEffect(rule.effect, rule.reason));
      }
    }

    return Promise.resolve(
      decisionForEffect(this.defaultEffect, `YAML policy default ${this.defaultEffect}`),
    );
  }
}

export function createYamlPolicyFromString(content: string): ToolPolicy {
  const parsed: unknown = parseYaml(content);
  if (!isRecord(parsed)) {
    throw new Error("YAML policy must be an object");
  }

  return new YamlPolicy(parseYamlPolicyConfig(parsed));
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
        args: redactValue(input.args) as Record<string, unknown>,
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
  };
}

function parseYamlPolicyRule(value: unknown, index: number): YamlPolicyRule {
  if (!isRecord(value)) {
    throw new Error(`YAML policy rule ${String(index)} must be an object`);
  }

  const effect = requiredString(value.effect, `rules[${String(index)}].effect`);
  validateYamlPolicyEffect(effect, `rules[${String(index)}].effect`);

  return {
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

function decisionForEffect(effect: YamlPolicyEffect, reason?: string): PolicyDecision {
  if (effect === "allow") {
    return { kind: "allow" };
  }

  return {
    kind: effect,
    reason: reason ?? `YAML policy ${effect}`,
  };
}
