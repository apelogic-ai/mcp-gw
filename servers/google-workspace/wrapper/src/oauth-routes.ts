import type { Hop1Identity } from "../../../../shared/identity/hop1";
import type { AuditSink } from "../../../../shared/audit/audit";
import {
  completeGoogleOAuth,
  GoogleOAuthError,
  startGoogleOAuth,
  type GoogleOAuthConfig,
  type OAuthFetch,
} from "../../../../shared/oauth/google";
import { oauthSuccessPage } from "../../../../shared/oauth/success-page";
import type { OAuthStateStore, OAuthTokenStore } from "../../../../shared/oauth/store";
import { ConnectionLifecycle } from "../../../../shared/oauth/connection-lifecycle";
import { ProviderLifecycleError } from "../../../../shared/oauth/connection-types";
import { createConnectionRouteHandler } from "../../../../shared/oauth/connection-routes";
import { GoogleConnectionAdapter } from "../../../../shared/oauth/provider-adapters";

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

export function createOAuthRouteHandler(
  options: CreateOAuthRouteHandlerOptions,
): (request: Request) => Promise<Response> {
  const authenticate = (token: string): Promise<Hop1Identity> => options.authenticate(token);
  const lifecycle = new ConnectionLifecycle({
    adapter: new GoogleConnectionAdapter(options.config, options.fetch),
    store: options.tokenStore,
    credentialEncryptionKey: options.config.tokenEncryptionKey,
    audit: options.audit,
  });
  const connectionRoutes = createConnectionRouteHandler({
    authenticate,
    lifecycle,
    requiredScopes: options.scopes,
    cancelAuthorization: (identity) =>
      options.stateStore.invalidatePrincipal(identity.issuer, identity.subject),
    startAuthorization: (identity, redirectAfter) =>
      startGoogleOAuth({
        identity,
        scopes: options.scopes,
        config: options.config,
        stateStore: options.stateStore,
        tokenStore: options.tokenStore,
        redirectAfter,
      }),
  });

  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/connections/google/")) return connectionRoutes(request);
    if (request.method === "GET" && url.pathname === "/oauth/google/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) {
        return json({ error: "Missing OAuth code or state" }, 400);
      }

      let completed;
      try {
        completed = await completeGoogleOAuth({
          identity: await authenticateRequest(request, authenticate),
          code,
          state,
          config: options.config,
          stateStore: options.stateStore,
          tokenStore: options.tokenStore,
          fetch: options.fetch,
        });
      } catch (error) {
        if (error instanceof GoogleOAuthError && error.code === "invalid_state") {
          return json({ error: "OAuth state is invalid, stale, or expired" }, 400);
        }
        if (error instanceof GoogleOAuthError && error.code === "email_mismatch") {
          return json({ error: "Google account identity does not match authenticated user" }, 400);
        }
        if (error instanceof GoogleOAuthError) {
          return json({ error: "Google OAuth callback could not be completed" }, 502);
        }
        throw error;
      }
      await options.audit?.emit({
        ts: new Date().toISOString(),
        category: "oauth",
        principal: completed.identity.email,
        event: "connect",
        status: "allow",
      });

      return completed.redirectAfter
        ? redirect(completed.redirectAfter)
        : oauthSuccessPage({ provider: "Google Workspace" });
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
        tokenStore: options.tokenStore,
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
        tokenStore: options.tokenStore,
        redirectAfter:
          typeof body.redirectAfter === "string" && body.redirectAfter.length > 0
            ? body.redirectAfter
            : undefined,
      });

      return json({ authorizationUrl: started.authorizationUrl });
    }

    if (request.method === "GET" && url.pathname === "/oauth/google/status") {
      const status = await lifecycle.status(identity, options.scopes);
      if (status.phase === "disconnected") return json({ connected: false });
      return json({
        connected: status.connected,
        ...(status.account ? { email: status.account.displayName } : {}),
        scopesRequired: status.requiredScopes,
        scopesGranted: status.grantedScopes,
        missingScopes: status.missingScopes,
      });
    }

    if (request.method === "POST" && url.pathname === "/oauth/google/refresh") {
      return json(await lifecycle.refresh(identity, options.scopes));
    }

    if (request.method === "POST" && url.pathname === "/oauth/google/disconnect") {
      try {
        try {
          await lifecycle.disconnect(identity, options.scopes);
        } finally {
          await invalidateAuthorizationSafely(options.stateStore, identity);
        }
      } catch (error) {
        if (error instanceof ProviderLifecycleError) {
          return json({ error: "Google account disconnect could not be completed" }, 503);
        }
        throw error;
      }
      return new Response(null, { status: 204 });
    }

    return json({ error: "Not found" }, 404);
  };
}

async function invalidateAuthorizationSafely(
  stateStore: OAuthStateStore,
  identity: Hop1Identity,
): Promise<void> {
  try {
    await stateStore.invalidatePrincipal(identity.issuer, identity.subject);
  } catch {
    // The lifecycle activation guard also rejects callbacks older than Disconnect.
  }
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
