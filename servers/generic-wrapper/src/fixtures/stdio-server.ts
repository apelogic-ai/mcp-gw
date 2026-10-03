import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let request: unknown;
  try {
    request = JSON.parse(line) as unknown;
  } catch {
    return;
  }
  if (!isRecord(request) || !("id" in request)) return;
  const params = isRecord(request.params) ? request.params : {};
  const result =
    request.method === "initialize"
      ? {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "stdio-fixture", version: "1.0.0" },
        }
      : {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                name: typeof params.name === "string" ? params.name : null,
                credentialPresent: Boolean(process.env.UPSTREAM_TOKEN),
              }),
            },
          ],
        };
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
