import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

import type { Hop1Identity } from "../shared/identity/hop1";
import type { ToolPolicy, ToolPolicyInput } from "../shared/policy/policy";
import {
  GITHUB_MCP_CATALOG_ID,
  GITHUB_MCP_READ_ONLY_TOOL_NAMES,
  GITHUB_MCP_SHIPPED_TOOLSETS,
  GITHUB_MCP_TOOL_GRANTS,
  GITHUB_MCP_TOOL_NAMES,
  GITHUB_MCP_TOOLSET_NAMES,
  parseGithubMcpToolsets,
} from "../servers/github-mcp/wrapper/src/catalog/github-mcp";
import { createGithubMcpProxyHandler } from "../servers/github-mcp/wrapper/src/proxy";
import {
  GITHUB_GOVERNANCE_CATALOG_SCHEMA_VERSION,
  buildGithubGovernanceCatalog,
  writeGithubGovernanceCatalog,
} from "../scripts/generate-github-governance-catalog";

const identity: Hop1Identity = {
  profile: "mint",
  issuer: "https://issuer.example.com",
  subject: "user-123",
  email: "user@example.com",
  claims: {},
};
const MINT_AUTHORITY_CLAIM = ["ste", "ward"].join("");

const DYNAMIC_WRITE_ARGS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  actions_run_trigger: { method: "run_workflow" },
  discussion_comment_write: { method: "add" },
  label_write: { method: "create" },
  manage_notification_subscription: { action: "watch" },
  manage_repository_notification_subscription: { action: "watch" },
  projects_write: { method: "create_project" },
  pull_request_review_write: { method: "create" },
  sub_issue_write: { method: "add" },
};

describe("GitHub governance release catalog", () => {
  test("serializes the complete pinned catalog and chart-default membership deterministically", async () => {
    const catalog = await buildGithubGovernanceCatalog();

    expect(catalog.schemaVersion).toBe(GITHUB_GOVERNANCE_CATALOG_SCHEMA_VERSION);
    expect(catalog.catalogId).toBe("github-mcp-server@1.6.0");
    expect(catalog.wrapperCatalogId).toBe(GITHUB_MCP_CATALOG_ID);
    expect(catalog.source).toEqual({
      repository: "ghcr.io/github/github-mcp-server",
      tag: "v1.6.0",
      digest: "sha256:2b0c48b070f61e9d3969269ead600f62d00fb237b60ac849ef3d166ee7de9ad3",
    });
    expect(catalog.chartDefaultToolsets).toEqual([...GITHUB_MCP_SHIPPED_TOOLSETS]);
    expect(catalog.tools).toHaveLength(84);
    expect(catalog.grants).toHaveLength(92);
    expect(new Set(catalog.tools.map((tool) => tool.resource))).toEqual(
      new Set(GITHUB_MCP_TOOL_NAMES),
    );
    expect(
      catalog.grants.map(({ provider, resource, action }) => ({ provider, resource, action })),
    ).toEqual([...GITHUB_MCP_TOOL_GRANTS]);
    expect(new Set(catalog.grants.map((grant) => grant.accessClass))).toEqual(
      new Set(["read", "write", "destructive"]),
    );
    expect(catalog.grants.every((grant) => grant.accessClass === grant.action)).toBe(true);
    expect(catalog.grants.filter((grant) => grant.accessClass === "read")).toHaveLength(54);
    expect(
      catalog.grants.filter((grant) => grant.accessClass === "read" && grant.chartDefaultEnabled),
    ).toHaveLength(40);
    expect(
      catalog.grants.every(
        (grant) =>
          grant.toolsets.length > 0 &&
          grant.toolsets.every((toolset) => GITHUB_MCP_TOOLSET_NAMES.includes(toolset)),
      ),
    ).toBe(true);
    expect(catalog.tools.find((tool) => tool.resource === "get_label")?.toolsets).toEqual([
      "issues",
      "labels",
    ]);
    expect(catalog.tools.find((tool) => tool.resource === "get_file_contents")).toMatchObject({
      upstreamReadOnlyHint: true,
      chartDefaultEnabled: true,
    });
    expect(catalog.tools.find((tool) => tool.resource === "get_gist")).toMatchObject({
      upstreamReadOnlyHint: true,
      chartDefaultEnabled: false,
    });

    const first = await writeGithubGovernanceCatalog();
    const second = await writeGithubGovernanceCatalog();
    expect(first).toBe(second);
    expect(JSON.parse(first)).toEqual(catalog);
  });

  test("derives chart-default flags from the toolsets shipped by the Helm chart", async () => {
    const values = parseYaml(await readFile("deploy/k8s/chart/values.yaml", "utf8")) as {
      githubMcp: { env: { GITHUB_TOOLSETS: string } };
    };
    const chartToolsets = parseGithubMcpToolsets(values.githubMcp.env.GITHUB_TOOLSETS);
    const catalog = await buildGithubGovernanceCatalog();

    expect(chartToolsets).toEqual([...GITHUB_MCP_SHIPPED_TOOLSETS]);
    expect(catalog.chartDefaultToolsets).toEqual(chartToolsets);
  });

  test("admits exactly an all-read consumer catalog carried by Mint grants", async () => {
    const releaseCatalog = await buildGithubGovernanceCatalog();
    const consumerCatalog = {
      schemaVersion: "steward.capability-catalog/v2",
      models: [],
      tools: releaseCatalog.grants
        .filter((grant) => grant.accessClass === "read")
        .map(({ provider, resource, action, accessClass, toolsets }) => ({
          provider,
          resource,
          action,
          accessClass,
          toolsets,
        })),
    };
    const mintIdentity: Hop1Identity = {
      ...identity,
      claims: {
        [MINT_AUTHORITY_CLAIM]: {
          tools: consumerCatalog.tools.map(({ provider, resource, action }) => ({
            provider,
            resource,
            action,
          })),
        },
      },
    };
    const policyInputs: ToolPolicyInput[] = [];
    const upstreamTools: string[] = [];
    const handler = createGithubMcpProxyHandler({
      upstreamUrl: "http://github-mcp:8082/mcp",
      governanceCatalogId: GITHUB_MCP_CATALOG_ID,
      githubToolsets: GITHUB_MCP_TOOLSET_NAMES,
      authenticate: () => Promise.resolve(mintIdentity),
      resolveGithubToken: () => Promise.resolve("provider-token"),
      getOAuthStatus: () =>
        Promise.resolve({
          connected: true,
          scopesRequired: ["repo"],
          scopesGranted: ["repo"],
          missingScopes: [],
        }),
      policy: mintGrantPolicy(policyInputs),
      fetch: async (request) => {
        const payload = (await request.json()) as { id: string; params: { name: string } };
        upstreamTools.push(payload.params.name);
        return Response.json({ jsonrpc: "2.0", id: payload.id, result: { admitted: true } });
      },
    });

    for (const resource of GITHUB_MCP_TOOL_NAMES) {
      const response = await rpc(handler, resource, DYNAMIC_WRITE_ARGS[resource] ?? {});
      expect(response.status).toBe(200);
    }

    const expectedReadResources = consumerCatalog.tools.map((tool) => tool.resource).sort();
    expect(upstreamTools.sort()).toEqual(expectedReadResources);
    expect(expectedReadResources).toEqual([...GITHUB_MCP_READ_ONLY_TOOL_NAMES].sort());
    expect(
      policyInputs
        .filter((input) => input.actionClass === "read")
        .map((input) => input.tool)
        .sort(),
    ).toEqual(expectedReadResources);
  });
});

function mintGrantPolicy(inputs: ToolPolicyInput[]): ToolPolicy {
  return {
    decide(input) {
      inputs.push(input);
      const authority = record(input.tokenClaims[MINT_AUTHORITY_CLAIM]);
      const tools = Array.isArray(authority?.tools) ? authority.tools : [];
      const allowed = tools.some((value) => {
        const grant = record(value);
        return (
          grant?.provider === input.service &&
          grant.resource === input.tool &&
          grant.action === input.actionClass
        );
      });
      return Promise.resolve(
        allowed ? { kind: "allow" } : { kind: "deny", reason: "Mint grant absent" },
      );
    },
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function rpc(
  handler: (request: Request) => Promise<Response>,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): Promise<Response> {
  return handler(
    new Request("http://wrapper/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer mint-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: tool,
        method: "tools/call",
        params: { name: tool, arguments: args },
      }),
    }),
  );
}
