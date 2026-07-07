import type { Hop1Identity } from "../../../../../shared/identity/hop1";
import { createMcpHttpHandler } from "./http";
import type { ToolRegistry } from "./registry";

interface ServerInfo {
  name: string;
  version: string;
}

export interface CreateAuthenticatedMcpHttpHandlerOptions {
  authenticate(token: string): Promise<Hop1Identity>;
  registryFor(identity: Hop1Identity): ToolRegistry;
  serverInfo: ServerInfo;
}

const JSON_HEADERS = {
  "content-type": "application/json",
};

export function createAuthenticatedMcpHttpHandler(
  options: CreateAuthenticatedMcpHttpHandlerOptions,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const token = bearerToken(request);
    if (!token) {
      return unauthorized("bearer token is required");
    }

    let identity: Hop1Identity;
    try {
      identity = await options.authenticate(token);
    } catch (error) {
      return unauthorized(error instanceof Error ? error.message : "invalid token");
    }

    const handler = createMcpHttpHandler({
      registry: options.registryFor(identity),
      serverInfo: options.serverInfo,
    });

    return handler(request);
  };
}

function bearerToken(request: Request): string | undefined {
  const header = request.headers.get("authorization");
  if (!header) {
    return undefined;
  }

  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) {
    return undefined;
  }

  return token;
}

function unauthorized(message: string): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32001,
        message: `Unauthorized: ${message}`,
      },
    }),
    {
      status: 401,
      headers: JSON_HEADERS,
    },
  );
}
