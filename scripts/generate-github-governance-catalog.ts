import { writeFile } from "node:fs/promises";

import type { PolicyActionClass } from "../shared/policy/policy";
import {
  GITHUB_MCP_CATALOG_ID,
  GITHUB_MCP_SHIPPED_TOOLSETS,
  GITHUB_MCP_TOOLS,
  GITHUB_MCP_TOOL_GRANTS,
  GITHUB_MCP_TOOLSET_NAMES,
  type GithubMcpToolName,
  type GithubMcpToolsetName,
} from "../servers/github-mcp/wrapper/src/catalog/github-mcp";
import { GITHUB_MCP_TOOLSET_TOOL_NAMES } from "../servers/github-mcp/wrapper/src/catalog/github-mcp-toolsets.generated";
import { resolveGitHubMcpSource } from "./resolve-github-mcp-source";

export const GITHUB_GOVERNANCE_CATALOG_SCHEMA_VERSION =
  "mcp-gw.github-governance-catalog/v1" as const;
export const GITHUB_GOVERNANCE_CATALOG_FILE_NAME = "github-governance-catalog.json" as const;

export interface GithubGovernanceCatalogTool {
  resource: GithubMcpToolName;
  toolsets: GithubMcpToolsetName[];
  actions: PolicyActionClass[];
  upstreamReadOnlyHint: boolean;
  chartDefaultEnabled: boolean;
}

export interface GithubGovernanceCatalogGrant {
  provider: "github";
  resource: GithubMcpToolName;
  action: PolicyActionClass;
  accessClass: PolicyActionClass;
  toolsets: GithubMcpToolsetName[];
  upstreamReadOnlyHint: boolean;
  chartDefaultEnabled: boolean;
}

export interface GithubGovernanceCatalog {
  schemaVersion: typeof GITHUB_GOVERNANCE_CATALOG_SCHEMA_VERSION;
  catalogId: string;
  wrapperCatalogId: typeof GITHUB_MCP_CATALOG_ID;
  source: {
    repository: string;
    tag: string;
    digest: string;
  };
  chartDefaultToolsets: GithubMcpToolsetName[];
  tools: GithubGovernanceCatalogTool[];
  grants: GithubGovernanceCatalogGrant[];
}

export async function buildGithubGovernanceCatalog(): Promise<GithubGovernanceCatalog> {
  const source = await resolveGitHubMcpSource();
  const toolsetsByResource = invertToolsets();
  const chartDefaultToolsets = new Set<GithubMcpToolsetName>(GITHUB_MCP_SHIPPED_TOOLSETS);
  const chartDefaultResources = new Set<GithubMcpToolName>();
  for (const toolset of chartDefaultToolsets) {
    for (const resource of GITHUB_MCP_TOOLSET_TOOL_NAMES[toolset]) {
      chartDefaultResources.add(resource);
    }
  }
  const definitions = new Map(GITHUB_MCP_TOOLS.map((tool) => [tool.name, tool]));

  return {
    schemaVersion: GITHUB_GOVERNANCE_CATALOG_SCHEMA_VERSION,
    catalogId: GITHUB_MCP_CATALOG_ID.replace(/\/all$/, ""),
    wrapperCatalogId: GITHUB_MCP_CATALOG_ID,
    source: {
      repository: source.sourceRepository,
      tag: source.sourceTag,
      digest: source.sourceDigest,
    },
    chartDefaultToolsets: [...GITHUB_MCP_SHIPPED_TOOLSETS],
    tools: GITHUB_MCP_TOOLS.map((tool) => ({
      resource: tool.name,
      toolsets: [...(toolsetsByResource.get(tool.name) ?? [])],
      actions: [...tool.grantActions],
      upstreamReadOnlyHint: tool.annotations.readOnlyHint,
      chartDefaultEnabled: chartDefaultResources.has(tool.name),
    })),
    grants: GITHUB_MCP_TOOL_GRANTS.map((grant) => {
      const definition = definitions.get(grant.resource);
      if (!definition) {
        throw new Error(`Missing GitHub MCP tool definition for ${grant.resource}`);
      }
      return {
        provider: grant.provider,
        resource: grant.resource,
        action: grant.action,
        accessClass: grant.action,
        toolsets: [...(toolsetsByResource.get(grant.resource) ?? [])],
        upstreamReadOnlyHint: definition.annotations.readOnlyHint,
        chartDefaultEnabled: chartDefaultResources.has(grant.resource),
      };
    }),
  };
}

export async function writeGithubGovernanceCatalog(outputPath?: string): Promise<string> {
  const serialized = `${JSON.stringify(await buildGithubGovernanceCatalog(), null, 2)}\n`;
  if (outputPath) {
    await writeFile(outputPath, serialized);
  }
  return serialized;
}

function invertToolsets(): Map<GithubMcpToolName, GithubMcpToolsetName[]> {
  const memberships = new Map<GithubMcpToolName, GithubMcpToolsetName[]>();
  for (const toolset of GITHUB_MCP_TOOLSET_NAMES) {
    for (const resource of GITHUB_MCP_TOOLSET_TOOL_NAMES[toolset]) {
      const existing = memberships.get(resource) ?? [];
      existing.push(toolset);
      memberships.set(resource, existing);
    }
  }
  return memberships;
}

function outputPath(args: string[]): string | undefined {
  const outputIndex = args.indexOf("--output");
  if (outputIndex === -1) return undefined;
  const path = args[outputIndex + 1];
  if (!path) throw new Error("--output requires a path");
  return path;
}

if (import.meta.main) {
  const path = outputPath(process.argv.slice(2));
  const serialized = await writeGithubGovernanceCatalog(path);
  if (!path) process.stdout.write(serialized);
}
