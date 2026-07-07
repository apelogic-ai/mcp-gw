import { decodeJwt } from "jose";
import type { Hop1Identity } from "../../../../shared/identity/hop1";
import type { AuditSink } from "../../../../shared/audit/audit";
import { encryptSecret } from "../../../../shared/oauth/crypto";
import {
  completeGoogleOAuth,
  DEFAULT_AUTHORIZATION_URL,
  DEFAULT_GOOGLE_TOKEN_URL,
  scopeStringToArray,
  startGoogleOAuth,
  type GoogleOAuthConfig,
  type OAuthFetch,
} from "../../../../shared/oauth/google";
import type { OAuthStateStore, OAuthTokenStore } from "../../../../shared/oauth/store";

export interface CreateOAuthRouteHandlerOptions {
  authenticate(token: string): Promise<Hop1Identity>;
  config: GoogleOAuthConfig;
  scopes: string[];
  stateStore: OAuthStateStore;
  tokenStore: OAuthTokenStore;
  audit?: AuditSink;
  fetch?: OAuthFetch;
}

const JSON_HEADERS = {
  "content-type": "application/json",
};

interface GoogleTokenEndpointResponse {
  access_token?: string;
  id_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

export function createOAuthRouteHandler(
  options: CreateOAuthRouteHandlerOptions,
): (request: Request) => Promise<Response> {
  const authenticate = (token: string): Promise<Hop1Identity> => options.authenticate(token);

  return async (request) => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/authorize") {
      return proxyClaudeAuthorizationRequest(url, options.config, options.scopes);
    }

    if (request.method === "POST" && url.pathname === "/token") {
      return proxyClaudeTokenExchange(
        request,
        options.config,
        options.tokenStore,
        options.fetch ?? fetch,
      );
    }

    if (request.method === "GET" && url.pathname === "/oauth/google/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) {
        return json({ error: "Missing OAuth code or state" }, 400);
      }

      const completed = await completeGoogleOAuth({
        identity: await authenticateRequest(request, authenticate),
        code,
        state,
        config: options.config,
        stateStore: options.stateStore,
        tokenStore: options.tokenStore,
        fetch: options.fetch,
      });
      await options.audit?.emit({
        ts: new Date().toISOString(),
        category: "oauth",
        principal: completed.identity.email,
        event: "connect",
        status: "allow",
      });

      return redirect(completed.redirectAfter ?? "/");
    }

    const identity = await authenticateRequest(request, authenticate);
    if (!identity) {
      return json({ error: "Unauthorized" }, 401);
    }

    if (request.method === "GET" && url.pathname === "/oauth/google/start") {
      const started = await startGoogleOAuth({
        identity,
        scopes: options.scopes,
        config: options.config,
        stateStore: options.stateStore,
        redirectAfter: url.searchParams.get("redirect_after") ?? undefined,
      });

      return redirect(started.authorizationUrl);
    }

    if (request.method === "POST" && url.pathname === "/oauth/google/start") {
      const body = await readJsonObject(request);
      const started = await startGoogleOAuth({
        identity,
        scopes: options.scopes,
        config: options.config,
        stateStore: options.stateStore,
        redirectAfter:
          typeof body.redirectAfter === "string" && body.redirectAfter.length > 0
            ? body.redirectAfter
            : undefined,
      });

      return json({ authorizationUrl: started.authorizationUrl });
    }

    if (request.method === "GET" && url.pathname === "/oauth/google/status") {
      const account = await options.tokenStore.getAccount(identity.issuer, identity.subject);
      if (!account || account.revokedAt) {
        return json({ connected: false });
      }
      const missingScopes = missingRequiredScopes(options.scopes, account.scopesGranted);

      return json({
        connected: missingScopes.length === 0,
        email: account.email,
        scopesRequired: options.scopes,
        scopesGranted: account.scopesGranted,
        missingScopes,
      });
    }

    if (request.method === "POST" && url.pathname === "/oauth/google/disconnect") {
      await options.tokenStore.markRevoked(identity.issuer, identity.subject, new Date());
      await options.audit?.emit({
        ts: new Date().toISOString(),
        category: "oauth",
        principal: identity.email,
        event: "disconnect",
        status: "allow",
      });
      return new Response(null, { status: 204 });
    }

    return json({ error: "Not found" }, 404);
  };
}

function proxyClaudeAuthorizationRequest(
  requestUrl: URL,
  config: GoogleOAuthConfig,
  scopes: string[],
): Response {
  if (requestUrl.searchParams.get("client_id") !== config.clientId) {
    return tokenError("invalid_client", "OAuth client_id does not match this MCP server");
  }

  const upstream = new URL(config.authorizationUrl ?? DEFAULT_AUTHORIZATION_URL);
  for (const [key, value] of requestUrl.searchParams.entries()) {
    upstream.searchParams.append(key, value);
  }
  upstream.searchParams.set("scope", scopes.join(" "));
  upstream.searchParams.set("access_type", "offline");
  upstream.searchParams.set("prompt", "consent");

  return redirect(upstream.toString());
}

async function proxyClaudeTokenExchange(
  request: Request,
  config: GoogleOAuthConfig,
  tokenStore: OAuthTokenStore,
  fetchImpl: OAuthFetch,
): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/x-www-form-urlencoded")) {
    return tokenError("invalid_request", "Expected application/x-www-form-urlencoded request");
  }

  const params = new URLSearchParams(await request.text());
  if (params.get("client_id") !== config.clientId) {
    return tokenError("invalid_client", "OAuth client_id does not match this MCP server");
  }

  params.set("client_secret", config.clientSecret);
  const upstream = await fetchImpl(config.tokenUrl ?? DEFAULT_GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params,
  });

  const text = await upstream.text();
  let body: GoogleTokenEndpointResponse;
  try {
    body = JSON.parse(text) as GoogleTokenEndpointResponse;
  } catch {
    return new Response(text, {
      status: upstream.status,
      headers: tokenResponseHeaders(upstream.headers.get("content-type") ?? "text/plain"),
    });
  }

  if (upstream.ok && body.id_token) {
    await persistGoogleAccountFromTokenResponse(body, config, tokenStore);
    body.access_token = body.id_token;
    body.token_type = body.token_type ?? "Bearer";
  }

  return new Response(JSON.stringify(body), {
    status: upstream.status,
    headers: tokenResponseHeaders("application/json"),
  });
}

async function persistGoogleAccountFromTokenResponse(
  body: GoogleTokenEndpointResponse,
  config: GoogleOAuthConfig,
  tokenStore: OAuthTokenStore,
): Promise<void> {
  if (!body.id_token || !body.refresh_token) {
    return;
  }

  const claims = decodeJwt(body.id_token);
  if (
    typeof claims.iss !== "string" ||
    typeof claims.sub !== "string" ||
    typeof claims.email !== "string"
  ) {
    return;
  }

  const now = new Date();
  await tokenStore.saveAccount({
    provider: "google",
    hop1Issuer: claims.iss,
    hop1Subject: claims.sub,
    email: claims.email,
    scopesGranted: scopeStringToArray(body.scope),
    encryptedRefreshToken: encryptSecret(body.refresh_token, config.tokenEncryptionKey),
    createdAt: now,
    updatedAt: now,
  });
}

async function authenticateRequest(
  request: Request,
  authenticate: (token: string) => Promise<Hop1Identity>,
): Promise<Hop1Identity | undefined> {
  const header = request.headers.get("authorization");
  const [scheme, token] = header?.split(" ") ?? [];
  if (scheme !== "Bearer" || !token) {
    return undefined;
  }

  try {
    return await authenticate(token);
  } catch {
    return undefined;
  }
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return {};
  }

  const text = await request.text();
  if (text.length === 0) {
    return {};
  }

  const parsed = JSON.parse(text) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function missingRequiredScopes(required: string[], granted: string[]): string[] {
  const grantedSet = new Set(granted);
  return required.filter((scope) => !grantedSet.has(scope));
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
}

function tokenError(error: string, errorDescription: string): Response {
  return new Response(JSON.stringify({ error, error_description: errorDescription }), {
    status: 400,
    headers: tokenResponseHeaders("application/json"),
  });
}

function tokenResponseHeaders(contentType: string): Record<string, string> {
  return {
    "content-type": contentType,
    "cache-control": "no-store",
    pragma: "no-cache",
  };
}
