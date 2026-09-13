import type { Hop1Identity } from "../identity/hop1";
import { ConnectionLifecycle } from "./connection-lifecycle";
import { ProviderLifecycleError } from "./connection-types";

export interface CreateConnectionRouteHandlerOptions {
  authenticate(token: string): Promise<Hop1Identity>;
  lifecycle: ConnectionLifecycle;
  requiredScopes: string[];
  startAuthorization(
    identity: Hop1Identity,
    redirectAfter?: string,
  ): Promise<{ authorizationUrl: string }>;
  cancelAuthorization?(identity: Hop1Identity): Promise<void>;
}

const JSON_HEADERS = { "content-type": "application/json" };

export function createConnectionRouteHandler(
  options: CreateConnectionRouteHandlerOptions,
): (request: Request) => Promise<Response> {
  const prefix = `/connections/${options.lifecycle.providerId}`;
  return async (request) => {
    const identity = await authenticateRequest(request, (token) => options.authenticate(token));
    if (!identity) return json({ error: "Unauthorized" }, 401);
    const pathname = new URL(request.url).pathname;
    try {
      if (request.method === "GET" && pathname === `${prefix}/status`) {
        return json(await options.lifecycle.status(identity, options.requiredScopes));
      }
      if (request.method === "POST" && pathname === `${prefix}/refresh`) {
        return json(await options.lifecycle.refresh(identity, options.requiredScopes));
      }
      if (request.method === "POST" && pathname === `${prefix}/disconnect`) {
        try {
          return json(await options.lifecycle.disconnect(identity, options.requiredScopes));
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
      return json({ error: "Not found" }, 404);
    } catch (error) {
      return connectionErrorResponse(error);
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
  if (error instanceof SyntaxError) {
    return json({ error: "invalid_request" }, 400);
  }
  if (error instanceof ProviderLifecycleError) {
    return json({ error: error.category }, lifecycleHttpStatus(error));
  }
  return json({ error: "persistence_failure" }, 503);
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
