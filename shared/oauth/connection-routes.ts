import type { Hop1Identity } from "../identity/hop1";
import { ConnectionLifecycle } from "./connection-lifecycle";
import { negotiatedConnectionStatus, negotiatedRefreshResult } from "./connection-status";
import { ProviderLifecycleError, type LifecycleErrorCategory } from "./connection-types";

export const CONNECTION_ROUTE_ERROR_CODES = [
  "oauth_invalid_request",
  "oauth_unauthorized",
  "oauth_route_not_found",
  "oauth_authorization_denied",
  "oauth_identity_mismatch",
  "oauth_generation_conflict",
  "oauth_invalid_active_credential",
  "oauth_invalid_renewal_credential",
  "oauth_renewal_expired",
  "oauth_insufficient_scope",
  "oauth_provider_unavailable",
  "oauth_provider_configuration_error",
  "oauth_provider_response_malformed",
  "oauth_persistence_failure",
  "oauth_redirect_target_not_allowed",
] as const;

export type ConnectionRouteErrorCode = (typeof CONNECTION_ROUTE_ERROR_CODES)[number];

export interface ConnectionRouteFailure {
  request: Request;
  identity?: Hop1Identity;
  status: number;
  code: ConnectionRouteErrorCode;
  details?: Readonly<Record<string, string>>;
}

export interface CreateConnectionRouteHandlerOptions {
  authenticate(token: string): Promise<Hop1Identity>;
  lifecycle: ConnectionLifecycle;
  requiredScopes: string[];
  startAuthorization(
    identity: Hop1Identity,
    redirectAfter?: string,
  ): Promise<{ authorizationUrl: string }>;
  cancelAuthorization?(identity: Hop1Identity): Promise<void>;
  /** Receives bounded, non-secret failure metadata after response classification. */
  reportFailure?(failure: ConnectionRouteFailure): void;
}

const JSON_HEADERS = { "content-type": "application/json" };

export function createConnectionRouteHandler(
  options: CreateConnectionRouteHandlerOptions,
): (request: Request) => Promise<Response> {
  const prefix = `/connections/${options.lifecycle.providerId}`;
  return async (request) => {
    const identity = await authenticateRequest(request, (token) => options.authenticate(token));
    if (!identity) {
      return reportedErrorResponse(options, request, undefined, {
        status: 401,
        error: "Unauthorized",
        code: "oauth_unauthorized",
      });
    }
    const pathname = new URL(request.url).pathname;
    try {
      if (request.method === "GET" && pathname === `${prefix}/status`) {
        return json(
          negotiatedConnectionStatus(
            request,
            await options.lifecycle.status(identity, options.requiredScopes),
          ),
        );
      }
      if (request.method === "POST" && pathname === `${prefix}/refresh`) {
        return json(
          negotiatedRefreshResult(
            request,
            await options.lifecycle.refresh(identity, options.requiredScopes),
          ),
        );
      }
      if (request.method === "POST" && pathname === `${prefix}/disconnect`) {
        try {
          return json(
            negotiatedConnectionStatus(
              request,
              await options.lifecycle.disconnect(identity, options.requiredScopes),
            ),
          );
        } finally {
          await cancelAuthorizationSafely(options, identity);
        }
      }
      if (request.method === "POST" && pathname === `${prefix}/authorize`) {
        const body = await readJsonObject(request);
        const redirectAfter =
          typeof body.redirectAfter === "string" && body.redirectAfter.length > 0
            ? body.redirectAfter
            : undefined;
        const continuation = await options.startAuthorization(identity, redirectAfter);
        await options.lifecycle.markAuthorizationStarted(
          identity,
          options.requiredScopes,
          new Date(Date.now() + 10 * 60 * 1000),
        );
        return json(continuation);
      }
      return reportedErrorResponse(options, request, identity, {
        status: 404,
        error: "Not found",
        code: "oauth_route_not_found",
      });
    } catch (error) {
      return reportedErrorResponse(options, request, identity, connectionErrorDetails(error));
    }
  };
}

export function withConnectionErrorMapping(
  handler: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      return await handler(request);
    } catch (error) {
      return connectionErrorResponse(error);
    }
  };
}

export function connectionErrorResponse(error: unknown): Response {
  const details = connectionErrorDetails(error);
  return json({ error: details.error, code: details.code }, details.status);
}

export class ConnectionRouteError extends ProviderLifecycleError {
  constructor(
    message: string,
    category: LifecycleErrorCategory,
    public readonly code: ConnectionRouteErrorCode,
    public readonly details?: Readonly<Record<string, string>>,
  ) {
    super(message, category);
    this.name = "ConnectionRouteError";
  }
}

export interface ConnectionErrorDetails {
  status: number;
  error: string;
  code: ConnectionRouteErrorCode;
  details?: Readonly<Record<string, string>>;
}

export function connectionErrorDetails(error: unknown): ConnectionErrorDetails {
  if (error instanceof SyntaxError) {
    return { status: 400, error: "invalid_request", code: "oauth_invalid_request" };
  }
  if (error instanceof ConnectionRouteError) {
    return {
      status: lifecycleHttpStatus(error),
      error: error.category,
      code: error.code,
      ...(error.details ? { details: error.details } : {}),
    };
  }
  if (error instanceof ProviderLifecycleError) {
    return {
      status: lifecycleHttpStatus(error),
      error: error.category,
      code: lifecycleErrorCode(error.category),
    };
  }
  return { status: 503, error: "persistence_failure", code: "oauth_persistence_failure" };
}

function reportedErrorResponse(
  options: CreateConnectionRouteHandlerOptions,
  request: Request,
  identity: Hop1Identity | undefined,
  details: ConnectionErrorDetails,
): Response {
  try {
    options.reportFailure?.({
      request,
      ...(identity ? { identity } : {}),
      status: details.status,
      code: details.code,
      ...(details.details ? { details: details.details } : {}),
    });
  } catch {
    // Failure telemetry must not change the sanitized HTTP response.
  }
  return json({ error: details.error, code: details.code }, details.status);
}

function lifecycleErrorCode(category: LifecycleErrorCategory): ConnectionRouteErrorCode {
  switch (category) {
    case "authorization_denied":
      return "oauth_authorization_denied";
    case "identity_mismatch":
      return "oauth_identity_mismatch";
    case "generation_conflict":
      return "oauth_generation_conflict";
    case "invalid_active_credential":
      return "oauth_invalid_active_credential";
    case "invalid_renewal_credential":
      return "oauth_invalid_renewal_credential";
    case "renewal_expired":
      return "oauth_renewal_expired";
    case "insufficient_scope":
      return "oauth_insufficient_scope";
    case "transient_provider_failure":
      return "oauth_provider_unavailable";
    case "provider_configuration_error":
      return "oauth_provider_configuration_error";
    case "malformed_provider_response":
      return "oauth_provider_response_malformed";
    case "persistence_failure":
      return "oauth_persistence_failure";
  }
}

async function cancelAuthorizationSafely(
  options: CreateConnectionRouteHandlerOptions,
  identity: Hop1Identity,
): Promise<void> {
  try {
    await options.cancelAuthorization?.(identity);
  } catch {
    // The generation guard still prevents an older callback from reactivating
    // the locally disabled connection when state invalidation is unavailable.
  }
}

async function authenticateRequest(
  request: Request,
  authenticate: (token: string) => Promise<Hop1Identity>,
): Promise<Hop1Identity | undefined> {
  const header = request.headers.get("authorization");
  const [scheme, token] = header?.split(" ") ?? [];
  if (scheme !== "Bearer" || !token) return undefined;
  try {
    return await authenticate(token);
  } catch {
    return undefined;
  }
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) return {};
  const text = await request.text();
  if (!text) return {};
  const value = JSON.parse(text) as unknown;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function lifecycleHttpStatus(error: ProviderLifecycleError): number {
  if (error.category === "authorization_denied" || error.category === "identity_mismatch") {
    return 400;
  }
  if (error.category === "generation_conflict") return 409;
  if (
    error.category === "invalid_active_credential" ||
    error.category === "invalid_renewal_credential" ||
    error.category === "renewal_expired" ||
    error.category === "insufficient_scope"
  ) {
    return 409;
  }
  return 503;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}
