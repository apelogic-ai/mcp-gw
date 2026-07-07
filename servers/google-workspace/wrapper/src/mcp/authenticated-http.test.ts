import { describe, expect, test } from "bun:test";

import type { Hop1Identity } from "../../../../../shared/identity/hop1";
import { createAuthenticatedMcpHttpHandler } from "./authenticated-http";
import type { ToolDefinition, ToolRegistry } from "./registry";

const identity: Hop1Identity = {
  profile: "google",
  issuer: "https://accounts.google.com",
  subject: "google-subject",
  email: "user@example.com",
  claims: {},
};

const identityTool: ToolDefinition = {
  name: "google_identity",
  description: "Return request identity.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
  },
};

function registryFor(requestIdentity: Hop1Identity): ToolRegistry {
  return {
    listTools: () => [identityTool],
    callTool: () =>
      Promise.resolve({
        content: [
          {
            type: "text",
            text: requestIdentity.email,
          },
        ],
      }),
  };
}

function request(body: unknown, authorization?: string): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (authorization) {
    headers.set("authorization", authorization);
  }

  return new Request("http://127.0.0.1/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("authenticated MCP HTTP handler", () => {
  test("rejects requests without a bearer token", async () => {
    const handler = createAuthenticatedMcpHttpHandler({
      authenticate: () => Promise.resolve(identity),
      registryFor,
      serverInfo: { name: "server", version: "0.1.0" },
    });

    const response = await handler(request({ jsonrpc: "2.0", id: 1, method: "tools/list" }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32001,
        message: "Unauthorized: bearer token is required",
      },
    });
  });

  test("rejects invalid bearer tokens", async () => {
    const handler = createAuthenticatedMcpHttpHandler({
      authenticate: () => Promise.reject(new Error("bad token")),
      registryFor,
      serverInfo: { name: "server", version: "0.1.0" },
    });

    const response = await handler(
      request({ jsonrpc: "2.0", id: "tools", method: "tools/list" }, "Bearer invalid"),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32001,
        message: "Unauthorized: bad token",
      },
    });
  });

  test("creates a request-scoped registry from the authenticated identity", async () => {
    const seenTokens: string[] = [];
    const handler = createAuthenticatedMcpHttpHandler({
      authenticate: (token) => {
        seenTokens.push(token);
        return Promise.resolve(identity);
      },
      registryFor,
      serverInfo: { name: "server", version: "0.1.0" },
    });

    const response = await handler(
      request(
        {
          jsonrpc: "2.0",
          id: "call",
          method: "tools/call",
          params: { name: "google_identity", arguments: {} },
        },
        "Bearer valid-token",
      ),
    );

    expect(response.status).toBe(200);
    expect(seenTokens).toEqual(["valid-token"]);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: "call",
      result: {
        content: [
          {
            type: "text",
            text: "user@example.com",
          },
        ],
      },
    });
  });
});
