import {
  OAuthBrokerError,
  type BeginAuthorizationRequest,
  type BrokerClient,
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
  beginAuthorization(
    request: BeginAuthorizationRequest,
  ): Promise<{ authorizationUrl: string; client: BrokerClient }>;
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
  googleCallbackUri?: string;
  registrationRateLimitKey?: (request: Request, context: AuthorizationRequestContext) => string;
}

export interface AuthorizationRequestContext {
  remoteAddress?: string;
}

const JSON_HEADERS = {
  "content-type": "application/json",
};
const NO_STORE_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
};
const MAX_REGISTRATION_BODY_BYTES = 16 * 1024;
const CLIENT_AUTHENTICATION_PARAMETERS = [
  "client_secret",
  "client_assertion",
  "client_assertion_type",
  "token_endpoint_auth_method",
] as const;
const HTTP_AUTH_SCHEME_PATTERN = /^([!#$%&'*+\-.^_`|~0-9A-Za-z]+)(?:\s|$)/u;

export interface AuthorizationServerPublicPaths {
  authorizationServerMetadata: string;
  protectedResourceMetadata: string;
  authorization: string;
  token: string;
  registration: string;
  jwks: string;
  googleCallback: string;
  googleCallbackUri: string;
  all: ReadonlySet<string>;
}

export function authorizationServerPublicPaths(
  options: CreateAuthorizationServerRouteHandlerOptions,
): AuthorizationServerPublicPaths {
  const metadata = options.broker.authorizationServerMetadata();
  const protectedMetadata = options.broker.protectedResourceMetadata();
  const issuer = absoluteMetadataUrl(metadata, "issuer");
  const resource = absoluteMetadataUrl(protectedMetadata, "resource");
  const authorization = absoluteMetadataUrl(metadata, "authorization_endpoint");
  const token = absoluteMetadataUrl(metadata, "token_endpoint");
  const jwks = absoluteMetadataUrl(metadata, "jwks_uri");
  const registration = new URL(`${issuer.toString().replace(/\/$/u, "")}/register`);
  const googleCallback = new URL(
    options.googleCallbackUri ??
      `${issuer.toString().replace(/\/$/u, "")}/oauth/google/broker/callback`,
  );
  for (const [name, url] of [
    ["authorization_endpoint", authorization],
    ["token_endpoint", token],
    ["jwks_uri", jwks],
    ["registration_endpoint", registration],
    ["google callback", googleCallback],
  ] as const) {
    if (url.origin !== issuer.origin || url.search || url.hash) {
      throw new Error(`${name} must be a clean URL on the authorization-server origin`);
    }
  }
  const authorizationServerMetadata = wellKnownPath(issuer, "oauth-authorization-server");
  const protectedResourceMetadata = wellKnownPath(resource, "oauth-protected-resource");
  const routePaths = [
    authorizationServerMetadata,
    protectedResourceMetadata,
    authorization.pathname,
    token.pathname,
    jwks.pathname,
    googleCallback.pathname,
    ...(options.registration ? [registration.pathname] : []),
  ];
  if (new Set(routePaths).size !== routePaths.length) {
    throw new Error("Authorization-server public routes must not overlap");
  }
  return {
    authorizationServerMetadata,
    protectedResourceMetadata,
    authorization: authorization.pathname,
    token: token.pathname,
    registration: registration.pathname,
    jwks: jwks.pathname,
    googleCallback: googleCallback.pathname,
    googleCallbackUri: googleCallback.toString(),
    all: new Set(routePaths),
  };
}

export function createAuthorizationServerRouteHandler(
  options: CreateAuthorizationServerRouteHandlerOptions,
): (request: Request, context?: AuthorizationRequestContext) => Promise<Response> {
  const paths = authorizationServerPublicPaths(options);

  return async (request, context = {}) => {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === paths.authorizationServerMetadata) {
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

      if (request.method === "GET" && url.pathname === paths.protectedResourceMetadata) {
        return publicJson(options.broker.protectedResourceMetadata());
      }

      if (request.method === "GET" && url.pathname === paths.jwks) {
        return publicJson(options.broker.jwks());
      }

      if (request.method === "POST" && url.pathname === paths.registration) {
        if (!options.registration) {
          return json({ error: "not_found" }, 404);
        }
        const metadata = await readBoundedJson(request);
        if (!options.registrationRateLimitKey) {
          throw new ConstrainedDcrError(
            "Registration admission identity is unavailable",
            "registry_full",
            503,
          );
        }
        const registered = await options.registration.register(metadata, {
          rateLimitKey: options.registrationRateLimitKey(request, context),
        });
        return json(registered, 201, NO_STORE_HEADERS);
      }

      if (request.method === "GET" && url.pathname === paths.authorization) {
        const authorization = authorizationRequest(url.searchParams);
        const started = await options.broker.beginAuthorization(authorization);
        return consentPage({
          authorizationUrl: started.authorizationUrl,
          callbackUrl: paths.googleCallbackUri,
          client: started.client,
          redirectUri: authorization.redirectUri,
        });
      }

      if (request.method === "GET" && url.pathname === paths.googleCallback) {
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

      if (request.method === "POST" && url.pathname === paths.token) {
        const authorizationHeaderError = rejectAuthorizationClientAuthentication(request);
        if (authorizationHeaderError) {
          return authorizationHeaderError;
        }
        const params = await readForm(request);
        if (hasFormClientAuthentication(params)) {
          return tokenError(
            "invalid_client",
            "Only unauthenticated public clients are supported",
            400,
          );
        }
        if (params.has("refresh_token")) {
          return tokenError("invalid_request", "Refresh tokens are not supported", 400);
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
        if (error.redirectUrl) {
          return redirect(error.redirectUrl);
        }
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
  const reader = (request.body as ReadableStream<Uint8Array> | null)?.getReader();
  if (!reader) {
    throw new ConstrainedDcrError("Registration metadata must be valid JSON", "invalid_request");
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let readResult = await reader.read();
  while (!readResult.done) {
    const value = readResult.value;
    bytes += value.byteLength;
    if (bytes > MAX_REGISTRATION_BODY_BYTES) {
      await reader.cancel();
      throw new ConstrainedDcrError(
        "Registration metadata is too large",
        "invalid_client_metadata",
      );
    }
    chunks.push(value);
    readResult = await reader.read();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
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

function absoluteMetadataUrl(metadata: Record<string, unknown>, field: string): URL {
  const value = metadata[field];
  if (typeof value !== "string") {
    throw new Error(`OAuth metadata is missing ${field}`);
  }
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`OAuth metadata ${field} must be an absolute HTTPS URL`);
  }
  return url;
}

function wellKnownPath(url: URL, suffix: string): string {
  const component = url.pathname === "/" ? "" : url.pathname;
  return `/.well-known/${suffix}${component}`;
}

function consentPage(input: {
  authorizationUrl: string;
  callbackUrl: string;
  client: BrokerClient;
  redirectUri: string;
}): Response {
  const authorizationUrl = new URL(input.authorizationUrl);
  const transactionState = authorizationUrl.searchParams.get("state") ?? "";
  const callback = new URL(input.callbackUrl);
  callback.searchParams.set("error", "access_denied");
  callback.searchParams.set("state", transactionState);
  const clientDisplay = input.client.clientName ?? input.client.clientId;
  const redirectOrigin = new URL(input.redirectUri).origin;
  const clientUri = input.client.clientUri
    ? `<p>Client website: <code>${escapeHtml(input.client.clientUri)}</code></p>`
    : "";
  const body = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize MCP client</title></head>
<body>
  <main>
    <h1>Authorize MCP client</h1>
    <p>Client: <code>${escapeHtml(clientDisplay)}</code></p>
    <p>Client ID: <code>${escapeHtml(input.client.clientId)}</code></p>
    ${clientUri}
    <p>Redirect origin: <code>${escapeHtml(redirectOrigin)}</code></p>
    <p>Exact redirect after sign-in: <code>${escapeHtml(input.redirectUri)}</code></p>
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

function rejectAuthorizationClientAuthentication(request: Request): Response | undefined {
  if (!request.headers.has("authorization")) return undefined;
  const authorization = request.headers.get("authorization") ?? "";
  const scheme = HTTP_AUTH_SCHEME_PATTERN.exec(authorization.trim())?.[1];
  return tokenError(
    "invalid_client",
    "Only unauthenticated public clients are supported",
    401,
    scheme ? `${scheme} realm="token"` : undefined,
  );
}

function hasFormClientAuthentication(params: URLSearchParams): boolean {
  return CLIENT_AUTHENTICATION_PARAMETERS.some((parameter) => params.has(parameter));
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

function tokenError(
  error: string,
  description: string,
  status: number,
  challenge?: string,
): Response {
  return json({ error, error_description: description }, status, {
    ...NO_STORE_HEADERS,
    ...(challenge ? { "www-authenticate": challenge } : {}),
  });
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}
