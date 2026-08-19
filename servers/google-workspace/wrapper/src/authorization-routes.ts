import {
  OAuthBrokerError,
  type BeginAuthorizationRequest,
  type BrokerTokenResponse,
  type OAuthBroker,
} from "../../../../shared/oauth/authorization-broker";
import {
  ConstrainedDcrError,
  type DcrRegistrationContext,
  type DcrRegistrationResponse,
} from "../../../../shared/oauth/dcr";

interface AuthorizationBrokerHttpContract {
  authorizationServerMetadata(): Record<string, unknown>;
  protectedResourceMetadata(): Record<string, unknown>;
  jwks(): { keys: Record<string, unknown>[] };
  beginAuthorization(request: BeginAuthorizationRequest): Promise<{ authorizationUrl: string }>;
  completeGoogleAuthorization(request: {
    transactionState: string;
    googleCode: string;
  }): Promise<{ redirectUrl: string }>;
  denyGoogleAuthorization(request: {
    transactionState: string;
    error: string;
  }): Promise<{ redirectUrl: string }>;
  exchangeAuthorizationCode(request: {
    grantType: string;
    code: string;
    clientId: string;
    redirectUri: string;
    resource: string;
    codeVerifier: string;
  }): Promise<BrokerTokenResponse>;
}

interface DcrHttpContract {
  register(metadata: unknown, context: DcrRegistrationContext): Promise<DcrRegistrationResponse>;
}

export interface CreateAuthorizationServerRouteHandlerOptions {
  broker: OAuthBroker | AuthorizationBrokerHttpContract;
  registration?: DcrHttpContract;
  googleCallbackPath?: string;
  registrationRateLimitKey?: (request: Request) => string;
}

const JSON_HEADERS = {
  "content-type": "application/json",
};
const NO_STORE_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
};
const MAX_REGISTRATION_BODY_BYTES = 16 * 1024;

export function createAuthorizationServerRouteHandler(
  options: CreateAuthorizationServerRouteHandlerOptions,
): (request: Request) => Promise<Response> {
  const callbackPath = options.googleCallbackPath ?? "/oauth/google/broker/callback";

  return async (request) => {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
        const metadata = options.broker.authorizationServerMetadata();
        return publicJson(
          options.registration
            ? {
                ...metadata,
                registration_endpoint: registrationEndpoint(metadata),
              }
            : metadata,
        );
      }

      if (
        request.method === "GET" &&
        url.pathname === "/.well-known/oauth-protected-resource/mcp"
      ) {
        return publicJson(options.broker.protectedResourceMetadata());
      }

      if (request.method === "GET" && url.pathname === "/.well-known/jwks.json") {
        return publicJson(options.broker.jwks());
      }

      if (request.method === "POST" && url.pathname === "/register") {
        if (!options.registration) {
          return json({ error: "not_found" }, 404);
        }
        const metadata = await readBoundedJson(request);
        const registered = await options.registration.register(metadata, {
          rateLimitKey: options.registrationRateLimitKey?.(request) ?? "global",
        });
        return json(registered, 201, NO_STORE_HEADERS);
      }

      if (request.method === "GET" && url.pathname === "/authorize") {
        const authorization = authorizationRequest(url.searchParams);
        const started = await options.broker.beginAuthorization(authorization);
        return consentPage({
          authorizationUrl: started.authorizationUrl,
          callbackUrl: authorizationCallbackUrl(
            options.broker.authorizationServerMetadata(),
            callbackPath,
          ),
          clientId: authorization.clientId,
          redirectUri: authorization.redirectUri,
        });
      }

      if (request.method === "GET" && url.pathname === callbackPath) {
        const transactionState = url.searchParams.get("state") ?? "";
        const error = url.searchParams.get("error");
        const result = error
          ? await options.broker.denyGoogleAuthorization({ transactionState, error })
          : await options.broker.completeGoogleAuthorization({
              transactionState,
              googleCode: url.searchParams.get("code") ?? "",
            });
        return redirect(result.redirectUrl);
      }

      if (request.method === "POST" && url.pathname === "/token") {
        const params = await readForm(request);
        if (params.has("client_secret") || params.has("refresh_token")) {
          return oauthError("invalid_client", "Only public clients are supported", 400);
        }
        const exchanged = await options.broker.exchangeAuthorizationCode({
          grantType: params.get("grant_type") ?? "",
          code: params.get("code") ?? "",
          clientId: params.get("client_id") ?? "",
          redirectUri: params.get("redirect_uri") ?? "",
          resource: params.get("resource") ?? "",
          codeVerifier: params.get("code_verifier") ?? "",
        });
        return json(
          {
            access_token: exchanged.accessToken,
            token_type: exchanged.tokenType,
            expires_in: exchanged.expiresIn,
            scope: exchanged.scope,
          },
          200,
          NO_STORE_HEADERS,
        );
      }

      return json({ error: "not_found" }, 404);
    } catch (error) {
      if (error instanceof OAuthBrokerError) {
        return oauthError(error.code, error.message, error.code === "server_error" ? 500 : 400);
      }
      if (error instanceof ConstrainedDcrError) {
        const externalCode =
          error.code === "rate_limited" || error.code === "registry_full"
            ? "temporarily_unavailable"
            : error.code;
        const response = oauthError(externalCode, error.message, error.httpStatus);
        if (error.code === "rate_limited") {
          response.headers.set("retry-after", "60");
        }
        return response;
      }
      return oauthError("server_error", "Authorization server request failed", 500);
    }
  };
}

function authorizationRequest(params: URLSearchParams): BeginAuthorizationRequest {
  return {
    responseType: params.get("response_type") ?? "",
    clientId: params.get("client_id") ?? "",
    redirectUri: params.get("redirect_uri") ?? "",
    resource: params.get("resource") ?? "",
    scope: params.get("scope") ?? "",
    codeChallenge: params.get("code_challenge") ?? "",
    codeChallengeMethod: params.get("code_challenge_method") ?? "",
    state: params.get("state") ?? undefined,
  };
}

async function readForm(request: Request): Promise<URLSearchParams> {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .includes("application/x-www-form-urlencoded")
  ) {
    throw new OAuthBrokerError(
      "invalid_request",
      "Expected application/x-www-form-urlencoded request",
    );
  }
  return new URLSearchParams(await request.text());
}

async function readBoundedJson(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new ConstrainedDcrError(
      "Expected an application/json registration request",
      "invalid_request",
    );
  }
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_REGISTRATION_BODY_BYTES) {
    throw new ConstrainedDcrError("Registration metadata is too large", "invalid_client_metadata");
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_REGISTRATION_BODY_BYTES) {
    throw new ConstrainedDcrError("Registration metadata is too large", "invalid_client_metadata");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ConstrainedDcrError("Registration metadata must be valid JSON", "invalid_request");
  }
}

function registrationEndpoint(metadata: Record<string, unknown>): string {
  const issuer = metadata.issuer;
  if (typeof issuer !== "string") {
    throw new Error("Authorization-server metadata is missing issuer");
  }
  return `${issuer.replace(/\/$/u, "")}/register`;
}

function authorizationCallbackUrl(metadata: Record<string, unknown>, callbackPath: string): string {
  const issuer = metadata.issuer;
  if (typeof issuer !== "string") {
    throw new Error("Authorization-server metadata is missing issuer");
  }
  return new URL(callbackPath, `${issuer.replace(/\/$/u, "")}/`).toString();
}

function consentPage(input: {
  authorizationUrl: string;
  callbackUrl: string;
  clientId: string;
  redirectUri: string;
}): Response {
  const authorizationUrl = new URL(input.authorizationUrl);
  const transactionState = authorizationUrl.searchParams.get("state") ?? "";
  const callback = new URL(input.callbackUrl);
  callback.searchParams.set("error", "access_denied");
  callback.searchParams.set("state", transactionState);
  const body = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize MCP client</title></head>
<body>
  <main>
    <h1>Authorize MCP client</h1>
    <p>Client: <code>${escapeHtml(input.clientId)}</code></p>
    <p>Redirect after sign-in: <code>${escapeHtml(input.redirectUri)}</code></p>
    <p><a href="${escapeHtml(input.authorizationUrl)}">Continue with Google</a></p>
    <p><a href="${escapeHtml(callback.toString())}">Deny</a></p>
  </main>
</body>
</html>`;
  return new Response(body, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
  });
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/gu,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] ?? character,
  );
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location, ...NO_STORE_HEADERS } });
}

function publicJson(body: unknown): Response {
  return json(body, 200, { "cache-control": "public, max-age=300" });
}

function oauthError(error: string, description: string, status: number): Response {
  return json({ error, error_description: description }, status, {
    ...NO_STORE_HEADERS,
    "www-authenticate": `Bearer error="${error}"`,
  });
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}
