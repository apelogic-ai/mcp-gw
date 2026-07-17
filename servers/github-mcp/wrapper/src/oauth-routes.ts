import type { Hop1Identity } from "../../../../shared/identity/hop1";
import type { AuditSink } from "../../../../shared/audit/audit";
import {
  completeGithubOAuth,
  startGithubOAuth,
  type GitHubOAuthConfig,
} from "../../../../shared/oauth/github";
import type { OAuthFetch } from "../../../../shared/oauth/google";
import type { OAuthStateStore, OAuthTokenStore } from "../../../../shared/oauth/store";

export interface CreateGitHubOAuthRouteHandlerOptions {
  authenticate(token: string): Promise<Hop1Identity>;
  config: GitHubOAuthConfig;
  scopes: string[];
  stateStore: OAuthStateStore;
  tokenStore: OAuthTokenStore;
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

  return async (request) => {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/oauth/github/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) {
        return json({ error: "Missing OAuth code or state" }, 400);
      }

      const completed = await completeGithubOAuth({
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
        event: "github.connect",
        status: "allow",
      });

      return redirect(completed.redirectAfter ?? "/");
    }

    const identity = await authenticateRequest(request, authenticate);
    if (!identity) {
      return json({ error: "Unauthorized" }, 401);
    }

    if (request.method === "GET" && url.pathname === "/oauth/github/start") {
      const started = await startGithubOAuth({
        identity,
        scopes: options.scopes,
        config: options.config,
        stateStore: options.stateStore,
        redirectAfter: url.searchParams.get("redirect_after") ?? undefined,
      });

      return redirect(started.authorizationUrl);
    }

    if (request.method === "POST" && url.pathname === "/oauth/github/start") {
      const body = await readJsonObject(request);
      const started = await startGithubOAuth({
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

    if (request.method === "GET" && url.pathname === "/oauth/github/status") {
      const account = await options.tokenStore.getAccount(
        identity.issuer,
        identity.subject,
        "github",
      );
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

    if (request.method === "POST" && url.pathname === "/oauth/github/disconnect") {
      await options.tokenStore.markRevoked(identity.issuer, identity.subject, new Date(), "github");
      await options.audit?.emit({
        ts: new Date().toISOString(),
        category: "oauth",
        principal: identity.email,
        event: "github.disconnect",
        status: "allow",
      });
      return new Response(null, { status: 204 });
    }

    return json({ error: "Not found" }, 404);
  };
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
