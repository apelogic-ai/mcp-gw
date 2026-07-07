import { describe, expect, test } from "bun:test";

import { createMcpHttpHandler } from "./http";
import type { ToolDefinition, ToolRegistry } from "./registry";

const echoTool: ToolDefinition = {
  name: "google_echo",
  description: "Echo test input.",
  inputSchema: {
    type: "object",
    properties: {
      message: { type: "string" },
    },
    required: ["message"],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
  },
};

const registry: ToolRegistry = {
  listTools: () => [echoTool],
  callTool: (name, args) => {
    if (name !== "google_echo") {
      throw new Error(`unexpected tool: ${name}`);
    }

    return Promise.resolve({
      content: [
        {
          type: "text",
          text: `echo:${String(args.message)}`,
        },
      ],
    });
  },
};

async function postJson(body: unknown): Promise<unknown> {
  const handler = createMcpHttpHandler({
    registry,
    serverInfo: {
      name: "google-workspace-wrapper",
      version: "0.1.0",
    },
  });

  const response = await handler(
    new Request("http://127.0.0.1/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

  expect(response.status).toBe(200);
  return response.json();
}

async function postRawJson(body: unknown): Promise<Response> {
  const handler = createMcpHttpHandler({
    registry,
    serverInfo: {
      name: "google-workspace-wrapper",
      version: "0.1.0",
    },
  });

  return handler(
    new Request("http://127.0.0.1/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("MCP HTTP handler", () => {
  test("returns server metadata for initialize", async () => {
    const result = await postJson({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test-client", version: "0.0.0" },
      },
    });

    expect(result).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "google-workspace-wrapper",
          version: "0.1.0",
        },
      },
    });
  });

  test("lists deterministic tools", async () => {
    const result = await postJson({
      jsonrpc: "2.0",
      id: "tools",
      method: "tools/list",
    });

    expect(result).toEqual({
      jsonrpc: "2.0",
      id: "tools",
      result: {
        tools: [echoTool],
      },
    });
  });

  test("accepts initialized notifications without a JSON-RPC response", async () => {
    const response = await postRawJson({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  test("calls a registered tool", async () => {
    const result = await postJson({
      jsonrpc: "2.0",
      id: "call",
      method: "tools/call",
      params: {
        name: "google_echo",
        arguments: {
          message: "hello",
        },
      },
    });

    expect(result).toEqual({
      jsonrpc: "2.0",
      id: "call",
      result: {
        content: [
          {
            type: "text",
            text: "echo:hello",
          },
        ],
      },
    });
  });

  test("returns an MCP error for unknown tools", async () => {
    const result = await postJson({
      jsonrpc: "2.0",
      id: "missing",
      method: "tools/call",
      params: {
        name: "google_missing",
        arguments: {},
      },
    });

    expect(result).toEqual({
      jsonrpc: "2.0",
      id: "missing",
      error: {
        code: -32602,
        message: "Unknown tool: google_missing",
      },
    });
  });

  test("returns an MCP error for malformed requests", async () => {
    const result = await postJson({ jsonrpc: "2.0", id: 5 });

    expect(result).toEqual({
      jsonrpc: "2.0",
      id: 5,
      error: {
        code: -32600,
        message: "Invalid request: method is required",
      },
    });
  });
});
