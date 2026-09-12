import type { Hop1Identity } from "../../../../shared/identity/hop1";
import type { AuditSink } from "../../../../shared/audit/audit";
import {
  cancelGithubOAuth,
  completeGithubOAuth,
  GitHubOAuthError,
  startGithubOAuth,
  type GitHubOAuthConfig,
} from "../../../../shared/oauth/github";
import type { OAuthFetch } from "../../../../shared/oauth/google";
import { oauthSuccessPage } from "../../../../shared/oauth/success-page";
import type { OAuthStateStore, OAuthTokenStore } from "../../../../shared/oauth/store";
import { ConnectionLifecycle } from "../../../../shared/oauth/connection-lifecycle";
import { ProviderLifecycleError } from "../../../../shared/oauth/connection-types";
import { createConnectionRouteHandler } from "../../../../shared/oauth/connection-routes";
import { GitHubConnectionAdapter } from "../../../../shared/oauth/provider-adapters";

export interface CreateGitHubOAuthRouteHandlerOptions {
  authenticate(token: string): Promise<Hop1Identity>;
  config: GitHubOAuthConfig;
  scopes: string[];
  stateStore: OAuthStateStore;
  tokenStore: OAuthTokenStore;
  /**
   * Explicit browser origins permitted after GitHub finishes the callback.
   * Relative paths remain local to the public wrapper origin. Remote targets
   * are rejected unless their URL origin is present here exactly.
   */
  redirectAfterAllowedOrigins?: string[];
  audit?: AuditSink;
  fetch?: OAuthFetch;
}

const JSON_HEADERS = {
  "content-type": "application/json",
};

export function createGitHubOAuthRouteHandler(
  options: CreateGitHubOAuthRouteHandlerOptions,
): (request: Request) => Promise<Response> {
  const authenticate = (token: string): Promise<Hop1Identity> => options.authenticate(token);
  const lifecycle = new ConnectionLifecycle({
    adapter: new GitHubConnectionAdapter(options.config, options.fetch),
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
    startAuthorization: (identity, redirectAfter) => {
      const validated = validateRedirectAfter(
        redirectAfter,
        options.redirectAfterAllowedOrigins ?? [],
      );
      if (validated instanceof OAuthRedirectTargetError) {
        throw new ProviderLifecycleError(
          "OAuth redirect target is not allowed",
          "authorization_denied",
        );
      }
      return startGithubOAuth({
        identity,
        scopes: options.scopes,
        config: options.config,
        stateStore: options.stateStore,
        tokenStore: options.tokenStore,
        redirectAfter: validated,
      });
    },
  });

  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/connections/github/")) return connectionRoutes(request);

    if (request.method === "GET" && url.pathname === "/oauth/github/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!state) {
        return json({ error: "Missing OAuth code or state" }, 400);
      }

      if (url.searchParams.has("error")) {
        try {
          const identity = await cancelGithubOAuth({
            state,
            stateStore: options.stateStore,
            tokenStore: options.tokenStore,
          });
          await options.audit?.emit({
            ts: new Date().toISOString(),
            category: "oauth",
            principal: identity.email,
            event: "github.connect",
            status: "deny",
            error: "github_authorization_denied",
          });
        } catch (error) {
          if (error instanceof GitHubOAuthError && error.code === "invalid_state") {
            return json({ error: "OAuth state is invalid or expired" }, 400);
          }
          throw error;
        }
        return json({ error: "GitHub authorization was not completed" }, 400);
      }

      if (!code) {
        return json({ error: "Missing OAuth code or state" }, 400);
      }

      let completed;
      try {
        completed = await completeGithubOAuth({
          identity: await authenticateRequest(request, authenticate),
          code,
          state,
          config: options.config,
          stateStore: options.stateStore,
          tokenStore: options.tokenStore,
          fetch: options.fetch,
        });
      } catch (error) {
        if (error instanceof GitHubOAuthError && error.code === "email_mismatch") {
          return json({ error: "GitHub account identity does not match authenticated user" }, 400);
        }
        if (error instanceof GitHubOAuthError && error.code === "invalid_state") {
          return json({ error: "OAuth state is invalid or expired" }, 400);
        }
        if (error instanceof GitHubOAuthError) {
          return json({ error: "GitHub OAuth callback could not be completed" }, 502);
        }
        throw error;
      }
      await options.audit?.emit({
        ts: new Date().toISOString(),
        category: "oauth",
        principal: completed.identity.email,
        event: "github.connect",
        status: "allow",
      });

      return completed.redirectAfter
        ? redirect(completed.redirectAfter)
        : oauthSuccessPage({ provider: "GitHub" });
    }

    const identity = await authenticateRequest(request, authenticate);
    if (!identity) {
      return json({ error: "Unauthorized" }, 401);
    }

    if (request.method === "GET" && url.pathname === "/oauth/github/start") {
      const redirectAfter = validateRedirectAfter(
        url.searchParams.get("redirect_after") ?? undefined,
        options.redirectAfterAllowedOrigins ?? [],
      );
      if (redirectAfter instanceof OAuthRedirectTargetError) {
        return json({ error: "OAuth redirect target is not allowed" }, 400);
      }
      const started = await startGithubOAuth({
        identity,
        scopes: options.scopes,
        config: options.config,
        stateStore: options.stateStore,
        tokenStore: options.tokenStore,
        redirectAfter,
      });

      return redirect(started.authorizationUrl);
    }

    if (request.method === "POST" && url.pathname === "/oauth/github/start") {
      const body = await readJsonObject(request);
      const redirectAfter = validateRedirectAfter(
        typeof body.redirectAfter === "string" && body.redirectAfter.length > 0
          ? body.redirectAfter
          : undefined,
        options.redirectAfterAllowedOrigins ?? [],
      );
      if (redirectAfter instanceof OAuthRedirectTargetError) {
        return json({ error: "OAuth redirect target is not allowed" }, 400);
      }
      const started = await startGithubOAuth({
        identity,
        scopes: options.scopes,
        config: options.config,
        stateStore: options.stateStore,
        tokenStore: options.tokenStore,
        redirectAfter,
      });

      return json({ authorizationUrl: started.authorizationUrl });
    }

    if (request.method === "GET" && url.pathname === "/oauth/github/status") {
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

    if (request.method === "POST" && url.pathname === "/oauth/github/refresh") {
      return json(await lifecycle.refresh(identity, options.scopes));
    }

    if (request.method === "POST" && url.pathname === "/oauth/github/disconnect") {
      try {
        try {
          await lifecycle.disconnect(identity, options.scopes);
        } finally {
          await invalidateAuthorizationSafely(options.stateStore, identity);
        }
      } catch (error) {
        if (error instanceof ProviderLifecycleError) {
          return json({ error: "GitHub account disconnect could not be completed" }, 503);
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

class OAuthRedirectTargetError extends Error {}

function validateRedirectAfter(
  redirectAfter: string | undefined,
  allowedOrigins: string[],
): string | undefined | OAuthRedirectTargetError {
  if (!redirectAfter) {
    return undefined;
  }

  // Parse relative targets instead of treating their text as opaque: browsers
  // normalize backslashes, so `/\\host` must not turn into a scheme-relative
  // redirect after we emit it in a Location header.
  if (redirectAfter.startsWith("/")) {
    const localOrigin = "https://mcp-gw.invalid";
    const localTarget = new URL(redirectAfter, localOrigin);
    if (localTarget.origin === localOrigin) {
      return `${localTarget.pathname}${localTarget.search}${localTarget.hash}`;
    }
    return new OAuthRedirectTargetError();
  }

  let target: URL;
  try {
    target = new URL(redirectAfter);
  } catch {
    return new OAuthRedirectTargetError();
  }

  const secureRemoteTarget = target.protocol === "https:";
  const explicitLoopbackTarget =
    target.protocol === "http:" && (target.hostname === "127.0.0.1" || target.hostname === "::1");
  if (
    (!secureRemoteTarget && !explicitLoopbackTarget) ||
    target.username.length > 0 ||
    target.password.length > 0 ||
    !allowedOrigins.includes(target.origin)
  ) {
    return new OAuthRedirectTargetError();
  }

  return target.toString();
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
