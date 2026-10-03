export type McpProxyFetch = (request: Request) => Promise<Response>;

export interface McpServerInfo {
  name: string;
  version: string;
}

export interface ForwardMcpRequestOptions {
  fetch: McpProxyFetch;
  upstreamUrl: string;
  request: Request;
  credential: string;
  body: string;
}

const FORWARDED_REQUEST_HEADERS = ["content-type", "mcp-protocol-version"];
const FORWARDED_RESPONSE_HEADERS = ["content-type", "mcp-session-id"];

export function forwardMcpRequest(options: ForwardMcpRequestOptions): Promise<Response> {
  return options.fetch(
    new Request(options.upstreamUrl, {
      method: options.request.method,
      headers: upstreamMcpHeaders(options.request, options.credential, options.body),
      body: options.body,
    }),
  );
}

export function upstreamMcpHeaders(request: Request, credential: string, body: string): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  headers.set("authorization", `Bearer ${credential}`);
  const metadata = parseMethod(body);
  if (metadata?.method) headers.set("mcp-method", metadata.method);
  if (metadata?.requestName) headers.set("mcp-name", metadata.requestName);
  for (const [name, value] of Object.entries(metadata?.requestArguments ?? {})) {
    const headerName = `mcp-param-${name}`;
    const headerValue = mcpParamHeaderValue(value);
    if (/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(headerName) && headerValue !== undefined) {
      headers.set(headerName, headerValue);
    }
  }
  return headers;
}

export function withUpstreamProtocolMetadata(
  request: Request,
  body: string,
  serverInfo: McpServerInfo,
): string {
  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    return body;
  }
  if (!isRecord(payload)) return body;

  const params = isRecord(payload.params) ? payload.params : {};
  const meta = isRecord(params._meta) ? params._meta : {};
  return JSON.stringify({
    ...payload,
    params: {
      ...params,
      _meta: {
        ...meta,
        "io.modelcontextprotocol/protocolVersion":
          request.headers.get("mcp-protocol-version") ?? "2025-06-18",
        "io.modelcontextprotocol/clientInfo": serverInfo,
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });
}

export function forwardedMcpResponseHeaders(response: Response): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function parseMethod(body: string):
  | {
      method: string;
      requestName?: string;
      requestArguments?: Record<string, unknown>;
    }
  | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(payload) || typeof payload.method !== "string") return undefined;
  const params = isRecord(payload.params) ? payload.params : undefined;
  const requestName =
    typeof params?.name === "string"
      ? params.name
      : typeof params?.uri === "string"
        ? params.uri
        : undefined;
  return {
    method: payload.method,
    ...(requestName ? { requestName } : {}),
    ...(isRecord(params?.arguments) ? { requestArguments: params.arguments } : {}),
  };
}

function mcpParamHeaderValue(value: unknown): string | undefined {
  if (typeof value === "string") return /[\r\n]/.test(value) ? undefined : value;
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
