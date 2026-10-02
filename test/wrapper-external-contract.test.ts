import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import { InMemoryAuditSink } from "../shared/audit/audit";
import type { Hop1Identity } from "../shared/identity/hop1";
import {
  CONNECTION_ROUTE_ERROR_CODES,
  ConnectionRouteError,
  connectionErrorDetails,
} from "../shared/oauth/connection-routes";
import { ProviderLifecycleError } from "../shared/oauth/connection-types";
import {
  GITHUB_MCP_CATALOG_ID,
  listStableGithubTools,
} from "../servers/github-mcp/wrapper/src/catalog/github-mcp";
import { createGithubMcpProxyHandler } from "../servers/github-mcp/wrapper/src/proxy";
import { createGoogleWorkspaceWrapperHandler } from "../servers/google-workspace/wrapper/src/app";

const identity: Hop1Identity = {
  profile: "contract",
  issuer: "https://identity.example.com",
  subject: "contract-user",
  email: "user@example.com",
  claims: {},
};

describe("bundled wrapper external contracts", () => {
  test("pins the Google Workspace MCP catalog, tool result, and audit event", async () => {
    const audit = new InMemoryAuditSink();
    const handler = createGoogleWorkspaceWrapperHandler({
      serverInfo: { name: "google-workspace-wrapper", version: "0.1.0" },
      authenticate: () => Promise.resolve(identity),
      getOAuthStatus: () =>
        Promise.resolve({
          connected: true,
          email: identity.email,
          scopesRequired: ["https://www.googleapis.com/auth/drive"],
          scopesGranted: ["https://www.googleapis.com/auth/drive"],
          missingScopes: [],
        }),
      startOAuth: () =>
        Promise.resolve({ authorizationUrl: "https://accounts.example.com/authorize" }),
      tokenBroker: {
        getGrantedScopes: () => Promise.resolve(["https://www.googleapis.com/auth/drive"]),
        getAccessToken: () => Promise.resolve("provider-credential"),
      },
      executor: ({ tool, args }) => Promise.resolve({ tool: tool.name, args, ok: true }),
      audit,
    });

    const tools = await rpc(handler, "google-tools", "tools/list");
    const listed = (tools.result as { tools: unknown[] }).tools;
    expect(catalogDigest(listed)).toBe(
      "0a31073df2a7f1423dd7c87d8a9829c2a6ff82ba329ae48d6c88b90182afe724",
    );

    const call = await rpc(handler, "google-call", "tools/call", {
      name: "google_drive_files_list",
      arguments: { pageSize: 5 },
    });
    expect(call).toEqual({
      jsonrpc: "2.0",
      id: "google-call",
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { tool: "google_drive_files_list", args: { pageSize: 5 }, ok: true },
              null,
              2,
            ),
          },
        ],
      },
    });
    expect(audit.events).toHaveLength(1);
    expect(withoutVolatileAuditFields(audit.events[0])).toEqual({
      category: "tool_call",
      principal: identity.email,
      status: "allow",
      tool: "google_drive_files_list",
      argDigest: "b80450a5fbab71e98b0fc779afc7ea757729cf62e0c7d542a359ec8d5745dc93",
      resultSize: 66,
    });
  });

  test("pins the GitHub MCP catalog, proxy headers, tool result, and audit event", async () => {
    const audit = new InMemoryAuditSink();
    const upstreamRequests: Request[] = [];
    const handler = createGithubMcpProxyHandler({
      upstreamUrl: "https://upstream.example.com/mcp",
      governanceCatalogId: GITHUB_MCP_CATALOG_ID,
      githubToolsets: ["repos"],
      githubScopes: ["repo"],
      authenticate: () => Promise.resolve(identity),
      getOAuthStatus: () =>
        Promise.resolve({
          connected: true,
          email: identity.email,
          scopesRequired: ["repo"],
          scopesGranted: ["repo"],
          missingScopes: [],
        }),
      resolveGithubToken: () => Promise.resolve("provider-credential"),
      fetch: async (request) => {
        upstreamRequests.push(request);
        const body = (await request.json()) as { id: string };
        return Response.json(
          { jsonrpc: "2.0", id: body.id, result: { ok: true } },
          {
            headers: { "mcp-session-id": "provider-session" },
          },
        );
      },
      audit,
    });

    const tools = await rpc(handler, "github-tools", "tools/list");
    const listed = (tools.result as { tools: unknown[] }).tools;
    expect(listed).toEqual([
      expect.objectContaining({ name: "github_oauth_status" }),
      expect.objectContaining({ name: "github_oauth_start" }),
      ...listStableGithubTools(["repos"], GITHUB_MCP_CATALOG_ID),
    ]);

    const response = await rpcResponse(handler, "github-call", "tools/call", {
      name: "get_file_contents",
      arguments: { owner: "example", repo: "fixture", path: "README.md" },
    });
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: "github-call",
      result: { ok: true },
    });
    expect(response.headers.get("mcp-session-id")).toBe("provider-session");
    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0]?.headers.get("authorization")).toBe("Bearer provider-credential");
    expect(upstreamRequests[0]?.headers.get("mcp-method")).toBe("tools/call");
    expect(upstreamRequests[0]?.headers.get("mcp-name")).toBe("get_file_contents");
    expect(upstreamRequests[0]?.headers.get("mcp-param-owner")).toBe("example");
    expect(upstreamRequests[0]?.headers.get("mcp-session-id")).toBeNull();
    expect(withoutVolatileAuditFields(audit.events[0])).toEqual({
      category: "tool_call",
      principal: identity.email,
      status: "allow",
      tool: "get_file_contents",
      argDigest: "fff11918d5ec1535dc248f147d617699f0d289d2d7fef653ac2acd9414365fd5",
      resultSize: 57,
      error: undefined,
    });
  });

  test("pins every stable connection-route error code and body classification", () => {
    expect(CONNECTION_ROUTE_ERROR_CODES).toEqual([
      "oauth_invalid_request",
      "oauth_unauthorized",
      "oauth_route_not_found",
      "oauth_authorization_denied",
      "oauth_identity_mismatch",
      "oauth_generation_conflict",
      "oauth_invalid_active_credential",
      "oauth_invalid_renewal_credential",
      "oauth_renewal_expired",
      "oauth_insufficient_scope",
      "oauth_provider_unavailable",
      "oauth_provider_configuration_error",
      "oauth_provider_response_malformed",
      "oauth_persistence_failure",
      "oauth_redirect_target_not_allowed",
    ]);

    expect(connectionErrorDetails(new SyntaxError("secret input"))).toEqual({
      status: 400,
      error: "invalid_request",
      code: "oauth_invalid_request",
    });
    expect(
      connectionErrorDetails(
        new ConnectionRouteError(
          "secret internal detail",
          "authorization_denied",
          "oauth_redirect_target_not_allowed",
          { redirectOrigin: "https://client.example.com" },
        ),
      ),
    ).toEqual({
      status: 400,
      error: "authorization_denied",
      code: "oauth_redirect_target_not_allowed",
      details: { redirectOrigin: "https://client.example.com" },
    });
    expect(connectionErrorDetails(new Error("database password leaked"))).toEqual({
      status: 503,
      error: "persistence_failure",
      code: "oauth_persistence_failure",
    });

    const categories = [
      ["authorization_denied", 400, "oauth_authorization_denied"],
      ["identity_mismatch", 400, "oauth_identity_mismatch"],
      ["generation_conflict", 409, "oauth_generation_conflict"],
      ["invalid_active_credential", 409, "oauth_invalid_active_credential"],
      ["invalid_renewal_credential", 409, "oauth_invalid_renewal_credential"],
      ["renewal_expired", 409, "oauth_renewal_expired"],
      ["insufficient_scope", 409, "oauth_insufficient_scope"],
      ["transient_provider_failure", 503, "oauth_provider_unavailable"],
      ["provider_configuration_error", 503, "oauth_provider_configuration_error"],
      ["malformed_provider_response", 503, "oauth_provider_response_malformed"],
      ["persistence_failure", 503, "oauth_persistence_failure"],
    ] as const;
    for (const [category, status, code] of categories) {
      expect(connectionErrorDetails(new ProviderLifecycleError("secret detail", category))).toEqual(
        { status, error: category, code },
      );
    }
  });
});

async function rpc(
  handler: (request: Request) => Promise<Response>,
  id: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return (await (await rpcResponse(handler, id, method, params)).json()) as Record<string, unknown>;
}

function rpcResponse(
  handler: (request: Request) => Promise<Response>,
  id: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<Response> {
  return handler(
    new Request("https://wrapper.example.com/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer hop1-credential",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
        "mcp-session-id": "caller-session",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }),
    }),
  );
}

function catalogDigest(catalog: unknown): string {
  return createHash("sha256").update(JSON.stringify(catalog)).digest("hex");
}

function withoutVolatileAuditFields(event: unknown): Record<string, unknown> | undefined {
  if (!event || typeof event !== "object" || Array.isArray(event)) return undefined;
  const { ts: _ts, latencyMs: _latencyMs, ...stable } = event as Record<string, unknown>;
  return stable;
}
