import { createHash } from "node:crypto";

import type { Hop1Identity } from "../../../../shared/identity/hop1";
import type { AuditEvent, AuditSink } from "../../../../shared/audit/audit";
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
import {
  acceptsConnectionStatusV2,
  githubOAuthCompatibilityStatus,
  negotiatedRefreshResult,
} from "../../../../shared/oauth/connection-status";
import {
  ConnectionRouteError,
  connectionErrorDetails,
  createConnectionRouteHandler,
  type ConnectionRouteErrorCode,
  type ConnectionRouteFailure,
} from "../../../../shared/oauth/connection-routes";
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

const GITHUB_ROUTE_LOG_LABELS = new Set([
  "/oauth/github/callback",
  "/oauth/github/start",
  "/oauth/github/status",
  "/oauth/github/refresh",
  "/oauth/github/disconnect",
  "/connections/github/authorize",
  "/connections/github/status",
  "/connections/github/refresh",
  "/connections/github/disconnect",
]);

type GitHubHttpErrorCode =
  | ConnectionRouteErrorCode
  | "oauth_callback_parameters_missing"
  | "oauth_state_invalid"
  | "oauth_callback_failed";

interface GitHubHttpErrorDetails {
  status: number;
  error: string;
  code: GitHubHttpErrorCode;
  details?: Readonly<Record<string, string>>;
}

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
      options.stateStore.invalidatePrincipal("github", identity.issuer, identity.subject),
    startAuthorization: (identity, redirectAfter) => {
      const validated = validateRedirectAfter(
        redirectAfter,
        options.redirectAfterAllowedOrigins ?? [],
      );
      if (validated instanceof OAuthRedirectTargetError) {
        throw new ConnectionRouteError(
          "OAuth redirect target is not allowed",
          "authorization_denied",
          "oauth_redirect_target_not_allowed",
          { redirectOrigin: rejectedRedirectOrigin(redirectAfter) },
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
    reportFailure: reportGitHubRouteFailure,
  });

  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/connections/github/")) return connectionRoutes(request);

    let identity: Hop1Identity | undefined;
    try {
      if (request.method === "GET" && url.pathname === "/oauth/github/callback") {
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!state) {
          return githubErrorResponse(request, undefined, {
            status: 400,
            error: "Missing OAuth code or state",
            code: "oauth_callback_parameters_missing",
          });
        }

        if (url.searchParams.has("error")) {
          try {
            identity = await cancelGithubOAuth({
              state,
              stateStore: options.stateStore,
              tokenStore: options.tokenStore,
            });
            await emitAuditSafely(options.audit, {
              ts: new Date().toISOString(),
              category: "oauth",
              principal: identity.email,
              event: "github.connect",
              status: "deny",
              error: "github_authorization_denied",
            });
          } catch (error) {
            if (error instanceof GitHubOAuthError && error.code === "invalid_state") {
              return githubErrorResponse(request, undefined, {
                status: 400,
                error: "OAuth state is invalid or expired",
                code: "oauth_state_invalid",
              });
            }
            throw error;
          }
          return githubErrorResponse(request, identity, {
            status: 400,
            error: "GitHub authorization was not completed",
            code: "oauth_authorization_denied",
          });
        }

        if (!code) {
          return githubErrorResponse(request, undefined, {
            status: 400,
            error: "Missing OAuth code or state",
            code: "oauth_callback_parameters_missing",
          });
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
            return githubErrorResponse(request, error.principal ?? identity, {
              status: 400,
              error: "GitHub account identity does not match authenticated user",
              code: "oauth_identity_mismatch",
            });
          }
          if (error instanceof GitHubOAuthError && error.code === "invalid_state") {
            return githubErrorResponse(request, error.principal ?? identity, {
              status: 400,
              error: "OAuth state is invalid or expired",
              code: "oauth_state_invalid",
            });
          }
          if (error instanceof GitHubOAuthError) {
            return githubErrorResponse(request, error.principal ?? identity, {
              status: 502,
              error: "GitHub OAuth callback could not be completed",
              code: "oauth_callback_failed",
            });
          }
          throw error;
        }
        await emitAuditSafely(options.audit, {
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

      identity = await authenticateRequest(request, authenticate);
      if (!identity) {
        return githubErrorResponse(request, undefined, {
          status: 401,
          error: "Unauthorized",
          code: "oauth_unauthorized",
        });
      }

      if (request.method === "GET" && url.pathname === "/oauth/github/start") {
        const requestedRedirect = url.searchParams.get("redirect_after") ?? undefined;
        const redirectAfter = validateRedirectAfter(
          requestedRedirect,
          options.redirectAfterAllowedOrigins ?? [],
        );
        if (redirectAfter instanceof OAuthRedirectTargetError) {
          return githubErrorResponse(request, identity, {
            status: 400,
            error: "OAuth redirect target is not allowed",
            code: "oauth_redirect_target_not_allowed",
            details: { redirectOrigin: rejectedRedirectOrigin(requestedRedirect) },
          });
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
        const requestedRedirect =
          typeof body.redirectAfter === "string" && body.redirectAfter.length > 0
            ? body.redirectAfter
            : undefined;
        const redirectAfter = validateRedirectAfter(
          requestedRedirect,
          options.redirectAfterAllowedOrigins ?? [],
        );
        if (redirectAfter instanceof OAuthRedirectTargetError) {
          return githubErrorResponse(request, identity, {
            status: 400,
            error: "OAuth redirect target is not allowed",
            code: "oauth_redirect_target_not_allowed",
            details: { redirectOrigin: rejectedRedirectOrigin(requestedRedirect) },
          });
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
        return json(githubOAuthCompatibilityStatus(status, acceptsConnectionStatusV2(request)));
      }

      if (request.method === "POST" && url.pathname === "/oauth/github/refresh") {
        return json(
          negotiatedRefreshResult(request, await lifecycle.refresh(identity, options.scopes)),
        );
      }

      if (request.method === "POST" && url.pathname === "/oauth/github/disconnect") {
        try {
          await lifecycle.disconnect(identity, options.scopes);
        } finally {
          await invalidateAuthorizationSafely(options.stateStore, identity);
        }
        return new Response(null, { status: 204 });
      }

      return githubErrorResponse(request, identity, {
        status: 404,
        error: "Not found",
        code: "oauth_route_not_found",
      });
    } catch (error) {
      const details = connectionErrorDetails(error);
      return githubErrorResponse(request, identity, details);
    }
  };
  return handler;
}

async function invalidateAuthorizationSafely(
  stateStore: OAuthStateStore,
  identity: Hop1Identity,
): Promise<void> {
  try {
    await stateStore.invalidatePrincipal("github", identity.issuer, identity.subject);
  } catch {
    // The lifecycle activation guard also rejects callbacks older than Disconnect.
  }
}

async function emitAuditSafely(audit: AuditSink | undefined, event: AuditEvent): Promise<void> {
  try {
    await audit?.emit(event);
  } catch {
    // Auditing must not change an already completed OAuth state transition.
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

function rejectedRedirectOrigin(redirectAfter: string | undefined): string {
  if (!redirectAfter) return "invalid";
  try {
    const target = new URL(redirectAfter, "https://mcp-gw.invalid");
    return target.origin === "null" ? "invalid" : target.origin;
  } catch {
    return "invalid";
  }
}

function reportGitHubRouteFailure(failure: ConnectionRouteFailure): void {
  reportGitHubHttpFailure(
    failure.request,
    failure.identity,
    failure.status,
    failure.code,
    failure.details,
  );
}

function githubErrorResponse(
  request: Request,
  identity: Pick<Hop1Identity, "issuer" | "subject"> | undefined,
  failure: GitHubHttpErrorDetails,
): Response {
  try {
    reportGitHubHttpFailure(request, identity, failure.status, failure.code, failure.details);
  } catch {
    // Diagnostics must never replace the stable, sanitized HTTP response.
  }
  return json({ error: failure.error, code: failure.code }, failure.status);
}

function reportGitHubHttpFailure(
  request: Request,
  identity: Pick<Hop1Identity, "issuer" | "subject"> | undefined,
  status: number,
  code: GitHubHttpErrorCode,
  details?: Readonly<Record<string, string>>,
): void {
  const rawPath = new URL(request.url).pathname;
  const route = boundedGitHubRoute(rawPath);
  const subjectHash = identity
    ? createHash("sha256")
        .update(identity.issuer)
        .update("\0")
        .update(identity.subject)
        .digest("hex")
    : "unavailable";
  const fields = [
    "github_oauth_request_failed",
    `code=${code}`,
    `status=${String(status)}`,
    `route=${route}`,
    `subject_hash=${subjectHash}`,
  ];
  if (details?.redirectOrigin) {
    fields.push(`redirect_origin=${JSON.stringify(details.redirectOrigin)}`);
  }
  console.warn(fields.join(" "));
}

function boundedGitHubRoute(pathname: string): string {
  if (GITHUB_ROUTE_LOG_LABELS.has(pathname)) return pathname;
  if (pathname.startsWith("/connections/github")) return "/connections/github/<unknown>";
  return "/oauth/github/<unknown>";
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
