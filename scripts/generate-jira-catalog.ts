import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export const JIRA_CAPTURE_SCHEMA_VERSION = "mcp-gateway.generic-catalog-capture/v1" as const;
export const JIRA_DECISIONS_SCHEMA_VERSION = "mcp-gw.jira-catalog-decisions/v1" as const;
export const JIRA_CATALOG_SCHEMA_VERSION = "mcp-gateway.generic-catalog/v1" as const;
export const JIRA_MCP_UPSTREAM = "https://mcp.atlassian.com/v2/mcp?tools=all" as const;

const JIRA_TOOL_SCOPES = new Set([
  "read:jira:agent-interface",
  "write:jira:agent-interface",
  "search:jira:agent-interface",
]);

interface JiraCapture {
  schemaVersion: typeof JIRA_CAPTURE_SCHEMA_VERSION;
  provider: "jira";
  upstream: typeof JIRA_MCP_UPSTREAM;
  capturedAt: string;
  pages: number;
  tools: JiraCapturedTool[];
}

interface JiraCapturedTool extends Record<string, unknown> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export type JiraCatalogDecision = JiraIncludeDecision | JiraExcludeDecision;

export interface JiraIncludeDecision {
  name: string;
  disposition: "include";
  alias: string;
  actionClass: "read" | "write";
  operation: string;
  scopes: string[];
}

export interface JiraExcludeDecision {
  name: string;
  disposition: "exclude";
  reason:
    | "credit_bearing_search"
    | "teamwork_graph_or_rovo_search"
    | "delete"
    | "attachment"
    | "admin"
    | "confluence"
    | "jsm"
    | "generic_execute_or_discover"
    | "unsupported";
}

interface JiraCatalogDecisions {
  schemaVersion: typeof JIRA_DECISIONS_SCHEMA_VERSION;
  catalogId: string;
  captureSha256: string;
  tools: JiraCatalogDecision[];
}

export interface JiraGeneratedCatalog {
  schemaVersion: typeof JIRA_CATALOG_SCHEMA_VERSION;
  catalogId: string;
  tools: Array<{
    name: string;
    alias: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations: { readOnlyHint: boolean; destructiveHint?: boolean };
    grants: {
      actionClass: "read" | "write";
      operation: string;
      scopes: string[];
    };
  }>;
}

export function captureSha256(serializedCapture: string): string {
  return createHash("sha256").update(serializedCapture).digest("hex");
}

export function buildJiraCatalog(
  rawCapture: unknown,
  rawDecisions: unknown,
  serializedCapture: string,
): JiraGeneratedCatalog {
  const capture = parseCapture(rawCapture);
  const decisions = parseDecisions(rawDecisions);
  const digest = captureSha256(serializedCapture);
  if (decisions.captureSha256 !== digest) {
    throw new Error(
      `Jira catalog decisions target sha256:${decisions.captureSha256}, received sha256:${digest}`,
    );
  }

  const capturedByName = new Map(capture.tools.map((tool) => [tool.name, tool]));
  const decisionsByName = new Map<string, JiraCatalogDecision>();
  const aliases = new Set<string>();
  for (const decision of decisions.tools) {
    if (decisionsByName.has(decision.name)) {
      throw new Error(`Duplicate Jira catalog decision for ${decision.name}`);
    }
    if (!capturedByName.has(decision.name)) {
      throw new Error(`Jira catalog decision names uncaptured tool ${decision.name}`);
    }
    decisionsByName.set(decision.name, decision);
    if (decision.disposition === "include") {
      if (decision.name === "search") {
        throw new Error("The credit-bearing Atlassian search tool cannot be included");
      }
      if (aliases.has(decision.alias)) {
        throw new Error(`Duplicate Jira stable alias ${decision.alias}`);
      }
      aliases.add(decision.alias);
    }
  }
  const undecided = capture.tools
    .map((tool) => tool.name)
    .filter((name) => !decisionsByName.has(name));
  if (undecided.length > 0) {
    throw new Error(`Jira capture contains tools without decisions: ${undecided.join(", ")}`);
  }

  const tools = capture.tools.flatMap((tool) => {
    const decision = decisionsByName.get(tool.name);
    if (!decision || decision.disposition === "exclude") return [];
    const upstreamReadOnly = tool.annotations?.readOnlyHint;
    if (upstreamReadOnly === false && decision.actionClass === "read") {
      throw new Error(`${tool.name} is not read-only upstream but is classified as read`);
    }
    if (tool.annotations?.destructiveHint === true) {
      throw new Error(`${tool.name} is destructive upstream and cannot be included`);
    }
    return [
      {
        name: tool.name,
        alias: decision.alias,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          readOnlyHint: decision.actionClass === "read",
          ...(decision.actionClass === "write" ? { destructiveHint: false } : {}),
        },
        grants: {
          actionClass: decision.actionClass,
          operation: decision.operation,
          scopes: [...decision.scopes],
        },
      },
    ];
  });
  if (tools.length === 0) throw new Error("Jira governed catalog must include at least one tool");
  tools.sort((left, right) => left.alias.localeCompare(right.alias));
  return {
    schemaVersion: JIRA_CATALOG_SCHEMA_VERSION,
    catalogId: decisions.catalogId,
    tools,
  };
}

function parseCapture(value: unknown): JiraCapture {
  const record = object(value, "capture");
  if (record.schemaVersion !== JIRA_CAPTURE_SCHEMA_VERSION) {
    throw new Error("Unexpected Jira capture schemaVersion");
  }
  if (record.provider !== "jira") throw new Error("Jira capture must use provider jira");
  if (record.upstream !== JIRA_MCP_UPSTREAM) {
    throw new Error(`Jira capture must use ${JIRA_MCP_UPSTREAM}`);
  }
  if (typeof record.capturedAt !== "string" || !record.capturedAt) {
    throw new Error("Jira capture requires capturedAt");
  }
  if (!Number.isInteger(record.pages) || Number(record.pages) < 1) {
    throw new Error("Jira capture requires a positive page count");
  }
  if (!Array.isArray(record.tools) || record.tools.length === 0) {
    throw new Error("Jira capture requires tools");
  }
  const names = new Set<string>();
  const tools = record.tools.map((value, index) => {
    const tool = object(value, `capture.tools[${String(index)}]`);
    const name = nonEmptyString(tool.name, `capture.tools[${String(index)}].name`);
    if (names.has(name)) throw new Error(`Jira capture contains duplicate tool ${name}`);
    names.add(name);
    return {
      ...tool,
      name,
      description: nonEmptyString(tool.description, `capture.tools[${String(index)}].description`),
      inputSchema: object(tool.inputSchema, `capture.tools[${String(index)}].inputSchema`),
      ...(tool.annotations === undefined
        ? {}
        : { annotations: object(tool.annotations, `capture.tools[${String(index)}].annotations`) }),
    };
  });
  return {
    schemaVersion: JIRA_CAPTURE_SCHEMA_VERSION,
    provider: "jira",
    upstream: JIRA_MCP_UPSTREAM,
    capturedAt: record.capturedAt,
    pages: Number(record.pages),
    tools,
  };
}

function parseDecisions(value: unknown): JiraCatalogDecisions {
  const record = object(value, "decisions");
  if (record.schemaVersion !== JIRA_DECISIONS_SCHEMA_VERSION) {
    throw new Error("Unexpected Jira decisions schemaVersion");
  }
  const catalogId = nonEmptyString(record.catalogId, "decisions.catalogId");
  if (!/^atlassian-rovo-v2@[a-zA-Z0-9._+-]+$/.test(catalogId)) {
    throw new Error("Jira catalogId must pin an atlassian-rovo-v2 revision");
  }
  const captureDigest = nonEmptyString(record.captureSha256, "decisions.captureSha256");
  if (!/^[a-f0-9]{64}$/.test(captureDigest)) {
    throw new Error("decisions.captureSha256 must be a lowercase SHA-256 digest");
  }
  if (!Array.isArray(record.tools) || record.tools.length === 0) {
    throw new Error("Jira decisions require tools");
  }
  const tools = record.tools.map((value, index) => parseDecision(value, index));
  return {
    schemaVersion: JIRA_DECISIONS_SCHEMA_VERSION,
    catalogId,
    captureSha256: captureDigest,
    tools,
  };
}

function parseDecision(value: unknown, index: number): JiraCatalogDecision {
  const record = object(value, `decisions.tools[${String(index)}]`);
  const name = nonEmptyString(record.name, `decisions.tools[${String(index)}].name`);
  if (record.disposition === "exclude") {
    const reasons = new Set([
      "credit_bearing_search",
      "teamwork_graph_or_rovo_search",
      "delete",
      "attachment",
      "admin",
      "confluence",
      "jsm",
      "generic_execute_or_discover",
      "unsupported",
    ]);
    const reason = nonEmptyString(record.reason, `decisions.tools[${String(index)}].reason`);
    if (!reasons.has(reason)) throw new Error(`Unsupported Jira exclusion reason ${reason}`);
    return { name, disposition: "exclude", reason } as JiraExcludeDecision;
  }
  if (record.disposition !== "include") {
    throw new Error(`Jira decision ${name} requires disposition include or exclude`);
  }
  const alias = nonEmptyString(record.alias, `decisions.tools[${String(index)}].alias`);
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(alias)) {
    throw new Error(`Jira stable alias ${alias} is invalid`);
  }
  if (alias === "oauth_start" || alias === "oauth_status") {
    throw new Error(`Jira stable alias ${alias} collides with a lifecycle helper`);
  }
  if (record.actionClass !== "read" && record.actionClass !== "write") {
    throw new Error(`Jira decision ${name} requires read or write actionClass`);
  }
  const operation = nonEmptyString(record.operation, `decisions.tools[${String(index)}].operation`);
  if (!/^jira\.[a-z][a-z0-9_.-]+$/.test(operation)) {
    throw new Error(`Jira operation ${operation} is invalid`);
  }
  if (!Array.isArray(record.scopes) || record.scopes.length === 0) {
    throw new Error(`Jira decision ${name} requires scopes`);
  }
  const scopes = record.scopes.map((value) => nonEmptyString(value, `${name}.scopes`));
  if (new Set(scopes).size !== scopes.length) {
    throw new Error(`Jira decision ${name} contains duplicate scopes`);
  }
  for (const scope of scopes) {
    if (!JIRA_TOOL_SCOPES.has(scope)) {
      throw new Error(`Jira tool ${name} uses unsupported scope ${scope}`);
    }
  }
  return {
    name,
    disposition: "include",
    alias,
    actionClass: record.actionClass,
    operation,
    scopes,
  };
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be non-empty`);
  return value.trim();
}

function requiredArg(argv: string[], name: string): string {
  const index = argv.indexOf(`--${name}`);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing required argument --${name}`);
  return value;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const capturePath = requiredArg(args, "capture");
  const decisionsPath = requiredArg(args, "decisions");
  const outputPath = requiredArg(args, "output");
  const serializedCapture = await readFile(capturePath, "utf8");
  const capture = JSON.parse(serializedCapture) as unknown;
  const decisions = parseYaml(await readFile(decisionsPath, "utf8")) as unknown;
  const catalog = buildJiraCatalog(capture, decisions, serializedCapture);
  await writeFile(outputPath, stringifyYaml(catalog, { lineWidth: 100 }));
  process.stdout.write(
    `Generated ${String(catalog.tools.length)} Jira tools from sha256:${captureSha256(serializedCapture)}\n`,
  );
}
