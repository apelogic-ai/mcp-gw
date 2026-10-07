import { randomUUID } from "node:crypto";

import type { GenericUpstreamCredential } from "./credentials";
import type { GenericUpstreamTransport } from "./transport";

export interface CapturedUpstreamTool extends Record<string, unknown> {
  name: string;
}

export interface CapturedUpstreamCatalog {
  pages: number;
  tools: CapturedUpstreamTool[];
}

export interface CaptureUpstreamCatalogOptions {
  transport: GenericUpstreamTransport;
  credential: GenericUpstreamCredential;
  principalKey: string;
  maxPages?: number;
  maxTools?: number;
}

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export async function captureUpstreamCatalog(
  options: CaptureUpstreamCatalogOptions,
): Promise<CapturedUpstreamCatalog> {
  const maxPages = positiveLimit(options.maxPages, 100, "maxPages");
  const maxTools = positiveLimit(options.maxTools, 5_000, "maxTools");
  const sessionId = randomUUID();
  options.transport.issueSession({ id: sessionId, principalKey: options.principalKey });
  const names = new Set<string>();
  const tools: CapturedUpstreamTool[] = [];
  let cursor: string | undefined;
  let pages = 0;

  try {
    do {
      pages += 1;
      if (pages > maxPages) throw new Error("Upstream catalog exceeded the page limit");
      const request = mcpRequest(sessionId, pages, cursor);
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: pages,
        method: "tools/list",
        params: cursor ? { cursor } : {},
      });
      const response = await options.transport.send({
        incomingRequest: request,
        body,
        credential: options.credential,
        principalKey: options.principalKey,
      });
      if (!response.ok) {
        throw new Error(`Upstream tools/list failed with HTTP ${String(response.status)}`);
      }
      const envelope = await decodeEnvelope(response);
      if (isRecord(envelope.error)) throw new Error("Upstream tools/list returned an MCP error");
      const result = isRecord(envelope.result) ? envelope.result : undefined;
      if (!result || !Array.isArray(result.tools)) {
        throw new Error("Upstream tools/list response is malformed");
      }
      for (const value of result.tools) {
        if (!isRecord(value) || typeof value.name !== "string" || value.name.length === 0) {
          throw new Error("Upstream tools/list returned a malformed tool");
        }
        if (names.has(value.name)) {
          throw new Error(`Upstream catalog contains duplicate tool name ${value.name}`);
        }
        names.add(value.name);
        tools.push({ ...value, name: value.name });
        if (tools.length > maxTools) throw new Error("Upstream catalog exceeded the tool limit");
      }
      cursor =
        typeof result.nextCursor === "string" && result.nextCursor.length > 0
          ? result.nextCursor
          : undefined;
    } while (cursor);
  } finally {
    await options.transport
      .close?.({
        incomingRequest: new Request("http://generic-wrapper.invalid/mcp", {
          method: "DELETE",
          headers: { "mcp-session-id": sessionId },
        }),
        body: "",
        credential: options.credential,
        principalKey: options.principalKey,
      })
      .catch(() => undefined);
  }

  if (tools.length === 1 && tools[0]?.name === "search") {
    throw new Error(
      "Atlassian exposed only the credit-bearing search tool; do not pin this catalog",
    );
  }
  if (tools.length === 0) throw new Error("Upstream catalog is empty");
  return { pages, tools };
}

function mcpRequest(sessionId: string, id: number, cursor?: string): Request {
  return new Request("http://generic-wrapper.invalid/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/list",
      params: cursor ? { cursor } : {},
    }),
  });
}

async function decodeEnvelope(response: Response): Promise<Record<string, unknown>> {
  const body = await readBoundedText(response, MAX_RESPONSE_BYTES);
  const payload = response.headers.get("content-type")?.includes("text/event-stream")
    ? body
        .split(/\r?\n/)
        .find((line) => line.startsWith("data:"))
        ?.slice(5)
        .trim()
    : body;
  if (!payload) throw new Error("Upstream tools/list response is empty");
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch {
    throw new Error("Upstream tools/list response is not valid JSON");
  }
  if (!isRecord(parsed)) throw new Error("Upstream tools/list response is malformed");
  return parsed;
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = "";
  for (;;) {
    const next = await reader.read();
    if (next.done) return body + decoder.decode();
    size += next.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Upstream tools/list response exceeded the size limit");
    }
    body += decoder.decode(next.value, { stream: true });
  }
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1) throw new Error(`${name} must be positive`);
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
