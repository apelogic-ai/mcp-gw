import type { GenericUpstreamCredential } from "./credentials";
import type { GenericUpstreamDescriptor } from "./descriptor";

export interface GenericUpstreamRequest {
  incomingRequest: Request;
  body: string;
  credential: GenericUpstreamCredential | null;
  principalKey: string;
}

export interface GenericUpstreamTransport {
  send(request: GenericUpstreamRequest): Promise<Response>;
  close?(sessionId: string | undefined, principalKey: string): Promise<void>;
}

export interface CreateHttpUpstreamTransportOptions {
  fetch?: typeof fetch;
}

const FORWARDED_HEADERS = ["accept", "content-type", "mcp-protocol-version", "mcp-session-id"];

export function createHttpUpstreamTransport(
  descriptor: Extract<GenericUpstreamDescriptor, { transport: "http" }>,
  options: CreateHttpUpstreamTransportOptions = {},
): GenericUpstreamTransport {
  const fetchImpl = options.fetch ?? fetch;
  return {
    async send(request) {
      const headers = new Headers();
      for (const name of FORWARDED_HEADERS) {
        const value = request.incomingRequest.headers.get(name);
        if (value) headers.set(name, value);
      }
      if (request.credential) {
        headers.set(request.credential.header, request.credential.value);
      }
      return fetchImpl(descriptor.url, {
        method: request.incomingRequest.method,
        headers,
        body: request.incomingRequest.method === "GET" ? undefined : request.body,
        signal: AbortSignal.timeout(descriptor.timeoutMs ?? 30_000),
      });
    },
  };
}
