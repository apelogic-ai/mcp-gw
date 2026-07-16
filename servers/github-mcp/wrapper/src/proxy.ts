import type { Hop1Identity } from "../../../../shared/identity/hop1";

export interface CreateGithubMcpProxyHandlerOptions {
  upstreamUrl: string;
  authenticate(token: string): Promise<Hop1Identity>;
  resolveGithubToken(identity: Hop1Identity): Promise<string | undefined>;
  fetch?: GithubMcpProxyFetch;
}

export type GithubMcpProxyFetch = (request: Request) => Promise<Response>;

const JSON_HEADERS = {
  "content-type": "application/json",
};

const FORWARDED_REQUEST_HEADERS = ["content-type", "mcp-protocol-version"];
const FORWARDED_RESPONSE_HEADERS = ["content-type", "mcp-session-id"];

export function createGithubMcpProxyHandler(
  options: CreateGithubMcpProxyHandlerOptions,
): (request: Request) => Promise<Response> {
  const fetchImpl = options.fetch ?? fetch;

  return async (request: Request): Promise<Response> => {
    const hop1Token = bearerToken(request);
    if (!hop1Token) {
      return unauthorized("bearer token is required");
    }

    let identity: Hop1Identity;
    try {
      identity = await options.authenticate(hop1Token);
    } catch (error) {
      return unauthorized(error instanceof Error ? error.message : "invalid token");
    }

    const githubToken = await options.resolveGithubToken(identity);
    if (!githubToken) {
      return unauthorized("GitHub account is not connected");
    }

    const upstreamResponse = await fetchImpl(
      new Request(options.upstreamUrl, {
        method: request.method,
        headers: upstreamHeaders(request, githubToken),
        body: request.body,
        // Bun and undici require duplex when forwarding a streamed request body.
        duplex: "half",
      }),
    );

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders(upstreamResponse),
    });
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

function upstreamHeaders(request: Request, githubToken: string): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) {
      headers.set(name, value);
    }
  }

  headers.set("authorization", `Bearer ${githubToken}`);
  return headers;
}

function responseHeaders(response: Response): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value) {
      headers.set(name, value);
    }
  }

  return headers;
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
