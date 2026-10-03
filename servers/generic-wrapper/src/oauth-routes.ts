import type { AuditSink } from "../../../shared/audit/audit";
import type { Hop1Identity } from "../../../shared/identity/hop1";
import {
  ConnectionRouteError,
  createConnectionRouteHandler,
} from "../../../shared/oauth/connection-routes";
import { oauthSuccessPage } from "../../../shared/oauth/success-page";
import type { OAuthStateStore, OAuthTokenStore } from "../../../shared/oauth/store";
import {
  cancelGenericOAuth,
  completeGenericOAuth,
  GenericOAuthError,
  startGenericOAuth,
  type GenericOAuthFetch,
  type GenericOAuthRuntimeConfig,
} from "./oauth";

export interface CreateGenericOAuthRouteHandlerOptions {
  authenticate(token: string): Promise<Hop1Identity>;
  config: GenericOAuthRuntimeConfig;
  stateStore: OAuthStateStore;
  tokenStore: OAuthTokenStore;
  fetch?: GenericOAuthFetch;
  audit?: AuditSink;
}

const JSON_HEADERS = { "content-type": "application/json" };

export function createGenericOAuthRouteHandler(
  options: CreateGenericOAuthRouteHandlerOptions,
): (request: Request) => Promise<Response> {
  const provider = options.config.descriptor.providerId;
  const callbackPath = `/oauth/${provider}/callback`;
  const lifecycle = options.config.lifecycle(options.tokenStore, options.fetch);
  const connectionRoutes = createConnectionRouteHandler({
    authenticate: (token) => options.authenticate(token),
    lifecycle,
    requiredScopes: options.config.descriptor.scopes,
    cancelAuthorization: (identity) =>
      options.stateStore.invalidatePrincipal(provider, identity.issuer, identity.subject),
    startAuthorization: (identity, redirectAfter) => {
      const safeRedirect = validateGenericRedirectAfter(redirectAfter);
      return startGenericOAuth({
        identity,
        config: options.config,
        stateStore: options.stateStore,
        tokenStore: options.tokenStore,
        redirectAfter: safeRedirect,
        fetch: options.fetch,
      });
    },
  });

  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith(`/connections/${provider}/`)) {
      return connectionRoutes(request);
    }
    if (request.method !== "GET" || url.pathname !== callbackPath) {
      return json({ error: "not_found", code: "oauth_route_not_found" }, 404);
    }

    const state = url.searchParams.get("state");
    if (!state) {
      return json({ error: "invalid_request", code: "oauth_callback_parameters_missing" }, 400);
    }
    if (url.searchParams.has("error")) {
      try {
        const identity = await cancelGenericOAuth({
          state,
          config: options.config,
          stateStore: options.stateStore,
          tokenStore: options.tokenStore,
        });
        await emitAudit(options.audit, identity, "deny", "authorization_denied");
        return json({ error: "authorization_denied", code: "oauth_authorization_denied" }, 400);
      } catch (error) {
        if (error instanceof GenericOAuthError && error.code === "invalid_state") {
          return json({ error: "invalid_state", code: "oauth_state_invalid" }, 400);
        }
        return json({ error: "callback_failed", code: "oauth_callback_failed" }, 502);
      }
    }

    const code = url.searchParams.get("code");
    if (!code) {
      return json({ error: "invalid_request", code: "oauth_callback_parameters_missing" }, 400);
    }
    try {
      const completed = await completeGenericOAuth({
        identity: await authenticateIfPresent(request, (token) => options.authenticate(token)),
        code,
        state,
        config: options.config,
        stateStore: options.stateStore,
        tokenStore: options.tokenStore,
        fetch: options.fetch,
      });
      await emitAudit(options.audit, completed.identity, "allow");
      if (completed.redirectAfter) {
        return new Response(null, {
          status: 302,
          headers: { location: new URL(completed.redirectAfter, url.origin).toString() },
        });
      }
      return oauthSuccessPage({ provider });
    } catch (error) {
      if (error instanceof GenericOAuthError && error.code === "invalid_state") {
        return json({ error: "invalid_state", code: "oauth_state_invalid" }, 400);
      }
      if (error instanceof GenericOAuthError && error.code === "identity_mismatch") {
        return json({ error: "identity_mismatch", code: "oauth_identity_mismatch" }, 400);
      }
      return json({ error: "callback_failed", code: "oauth_callback_failed" }, 502);
    }
  };
}

export function validateGenericRedirectAfter(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const localOrigin = "https://mcp-gw.invalid";
  let target: URL;
  try {
    target = new URL(value, localOrigin);
  } catch {
    throw redirectTargetError();
  }
  if (!value.startsWith("/") || target.origin !== localOrigin) {
    throw redirectTargetError();
  }
  return `${target.pathname}${target.search}${target.hash}`;
}

function redirectTargetError(): ConnectionRouteError {
  return new ConnectionRouteError(
    "OAuth redirect target is not allowed",
    "authorization_denied",
    "oauth_redirect_target_not_allowed",
  );
}

async function authenticateIfPresent(
  request: Request,
  authenticate: (token: string) => Promise<Hop1Identity>,
): Promise<Hop1Identity | undefined> {
  const [scheme, token, extra] = request.headers.get("authorization")?.split(" ") ?? [];
  if (scheme !== "Bearer" || !token || extra) return undefined;
  return authenticate(token);
}

async function emitAudit(
  audit: AuditSink | undefined,
  identity: Hop1Identity,
  status: "allow" | "deny",
  error?: string,
): Promise<void> {
  try {
    await audit?.emit({
      ts: new Date().toISOString(),
      category: "oauth",
      principal: identity.email,
      status,
      event: "generic.connect",
      ...(error ? { error } : {}),
    });
  } catch {
    // Audit availability must not change the OAuth result.
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}
