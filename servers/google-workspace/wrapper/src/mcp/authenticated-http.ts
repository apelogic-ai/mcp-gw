import {
  classifyHop1ValidationFailure,
  reportHop1AuthenticationFailure,
  type Hop1FailureReporter,
  type Hop1Identity,
} from "../../../../../shared/identity/hop1";
import { createMcpHttpHandler } from "./http";
import type { ToolRegistry } from "./registry";

interface ServerInfo {
  name: string;
  version: string;
}

export interface CreateAuthenticatedMcpHttpHandlerOptions {
  authenticate(token: string): Promise<Hop1Identity>;
  registryFor(identity: Hop1Identity): ToolRegistry | Promise<ToolRegistry>;
  serverInfo: ServerInfo;
  onAuthenticationFailure?: Hop1FailureReporter;
}

const JSON_HEADERS = {
  "content-type": "application/json",
};

export function createAuthenticatedMcpHttpHandler(
  options: CreateAuthenticatedMcpHttpHandlerOptions,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const reportFailure = options.onAuthenticationFailure ?? reportHop1AuthenticationFailure;
    const token = bearerToken(request);
    if (!token) {
      reportFailure("missing_bearer");
      return unauthorized("bearer token is required");
    }

    let identity: Hop1Identity;
    try {
      identity = await options.authenticate(token);
    } catch (error) {
      reportFailure(classifyHop1ValidationFailure(error));
      return unauthorized("invalid bearer token");
    }

    const handler = createMcpHttpHandler({
      registry: await options.registryFor(identity),
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
