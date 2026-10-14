import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname !== "/mcp") return new Response(null, { status: 404 });
    const authorization = request.headers.get("authorization");
    if (authorization === "Bearer fail-token") {
      return new Response("fixture unavailable", { status: 503 });
    }
    if (authorization !== "Bearer provider-token") {
      return new Response("unauthorized", { status: 401 });
    }

    // The low-level API is intentional: this protocol fixture controls pagination.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const mcp = new Server(
      { name: "live-catalog-fixture", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    mcp.setRequestHandler(ListToolsRequestSchema, (message) => {
      if (message.params?.cursor === "page-2") {
        return Promise.resolve({
          tools: [
            {
              name: "editIssue",
              description: "Edit an issue using the live upstream schema.",
              inputSchema: {
                type: "object",
                properties: {
                  cloudId: { type: "string" },
                  issueKey: { type: "string" },
                },
                required: ["cloudId", "issueKey"],
              },
            },
          ],
        });
      }
      return Promise.resolve({
        tools: [
          {
            name: "getIssue",
            description: "Get an issue using the live upstream schema.",
            inputSchema: {
              type: "object",
              properties: {
                cloudId: { type: "string" },
                issueKey: { type: "string" },
              },
              required: ["cloudId", "issueKey"],
            },
          },
          {
            name: "newUndecidedTool",
            description: "A newly added upstream tool without an authority decision.",
            inputSchema: { type: "object" },
          },
        ],
        nextCursor: "page-2",
      });
    });
    mcp.setRequestHandler(CallToolRequestSchema, (message) =>
      Promise.resolve({
        content: [{ type: "text", text: `called:${message.params.name}` }],
      }),
    );
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await mcp.connect(transport);
    return transport.handleRequest(request);
  },
});

process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${String(server.port)}/mcp` })}\n`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void server.stop(true).then(() => process.exit(0));
  });
}
