import {
  classifyHop1ValidationFailure,
  reportHop1AuthenticationFailure,
  type Hop1Identity,
} from "../../../shared/identity/hop1";
import { parseTaskToolAuthorization, type TaskToolAuthorization } from "./task-tool-authorization";

const TASK_AUTHORITY_CLAIM = ["ste", "ward"].join("");

export type AuthenticatedTaskRequest =
  | { ok: true; identity: Hop1Identity; authorization: TaskToolAuthorization }
  | { ok: false; response: Response };

export async function authenticateTaskRequest(
  request: Request,
  authenticate: (token: string) => Promise<Hop1Identity>,
): Promise<AuthenticatedTaskRequest> {
  const token = bearerToken(request);
  if (!token) {
    reportHop1AuthenticationFailure("missing_bearer");
    return {
      ok: false,
      response: jsonError(401, "unauthorized", "bearer token is required", {
        "www-authenticate": "Bearer",
      }),
    };
  }
  try {
    const identity = await authenticate(token);
    return {
      ok: true,
      identity,
      authorization: parseTaskToolAuthorization(identity.claims),
    };
  } catch (error) {
    reportHop1AuthenticationFailure(classifyHop1ValidationFailure(error));
    return {
      ok: false,
      response: jsonError(401, "unauthorized", "invalid bearer token", {
        "www-authenticate": 'Bearer error="invalid_token"',
      }),
    };
  }
}

export async function readBoundedJson(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const declaredBytes = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
    return {
      ok: false,
      response: jsonError(413, "request_too_large", "Request body is too large"),
    };
  }
  if (!request.body) {
    return {
      ok: false,
      response: jsonError(400, "invalid_request", "Request body must be JSON"),
    };
  }
  const reader = (request.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let chunk = await reader.read();
  while (!chunk.done) {
    const { value } = chunk;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      return {
        ok: false,
        response: jsonError(413, "request_too_large", "Request body is too large"),
      };
    }
    chunks.push(value);
    chunk = await reader.read();
  }
  try {
    return {
      ok: true,
      value: JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))) as unknown,
    };
  } catch {
    return {
      ok: false,
      response: jsonError(400, "invalid_request", "Request body must be JSON"),
    };
  }
}

export function jsonError(
  status: number,
  error: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return Response.json({ error, message }, { status, headers });
}

export function taskOwner(identity: Hop1Identity): string | undefined {
  const authority = identity.claims[TASK_AUTHORITY_CLAIM];
  if (!isRecord(authority) || typeof authority.runtime_uid !== "string") return undefined;
  const runtimeUid = authority.runtime_uid.trim();
  return runtimeUid ? JSON.stringify([identity.issuer, identity.subject, runtimeUid]) : undefined;
}

export function ndjsonLine(event: unknown): string {
  return `${JSON.stringify(event)}\n`;
}

export function ndjsonResponse(events: readonly unknown[]): Response {
  return new Response(events.map(ndjsonLine).join(""), {
    headers: { "content-type": "application/x-ndjson" },
  });
}

function bearerToken(request: Request): string | undefined {
  const [scheme, token] = request.headers.get("authorization")?.split(" ") ?? [];
  return scheme === "Bearer" && token ? token : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
