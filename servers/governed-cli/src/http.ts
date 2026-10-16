import {
  classifyHop1ValidationFailure,
  reportHop1AuthenticationFailure,
  type Hop1Identity,
} from "../../../shared/identity/hop1";
import { parseTaskToolAuthorization } from "../../../packages/wrapper-kit/src/task-tool-authorization";
import type { CliDecisionCatalog } from "./catalog";
import { CommandRefusedError, type CommandClassifier } from "./classifier";
import { executeCli, type CliExecutionOptions, type CliRunnerConfig } from "./executor";

export interface CliTarget {
  catalog: CliDecisionCatalog;
  classifier: CommandClassifier;
  runner: CliRunnerConfig;
  credentialEnv?: (identity: Hop1Identity) => Promise<Readonly<Record<string, string>>>;
}

export interface CreateCliRunHandlerOptions {
  authenticate(token: string): Promise<Hop1Identity>;
  targets: readonly CliTarget[];
  requestLimits: {
    maxBodyBytes: number;
    maxArgs: number;
    maxArgBytes: number;
  };
  execute?: typeof executeCli;
}

export function createCliRunHandler(
  options: CreateCliRunHandlerOptions,
): (request: Request) => Promise<Response> {
  const targets = new Map(options.targets.map((target) => [target.catalog.cli, target]));
  const execute = options.execute ?? executeCli;

  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== "/cli/run") return errorResponse(404, "not_found", "Not found");
    if (request.method !== "POST") {
      return errorResponse(405, "method_not_allowed", "POST is required");
    }
    const wait = url.searchParams.get("wait");
    if (wait !== null && wait !== "full") {
      return errorResponse(400, "invalid_request", "Only wait=full is supported");
    }

    const token = bearerToken(request);
    if (!token) {
      reportHop1AuthenticationFailure("missing_bearer");
      return unauthorized("bearer token is required", "Bearer");
    }

    let identity: Hop1Identity;
    try {
      identity = await options.authenticate(token);
    } catch (error) {
      reportHop1AuthenticationFailure(classifyHop1ValidationFailure(error));
      return unauthorized("invalid bearer token", 'Bearer error="invalid_token"');
    }

    const parsedBody = await readBoundedJson(request, options.requestLimits.maxBodyBytes);
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.value;
    if (!isRecord(body) || Object.keys(body).some((key) => !["cli", "args"].includes(key))) {
      return errorResponse(400, "invalid_request", "Only cli and args are supported");
    }
    if (
      typeof body.cli !== "string" ||
      !Array.isArray(body.args) ||
      body.args.some((arg) => typeof arg !== "string")
    ) {
      return errorResponse(400, "invalid_request", "cli and string-array args are required");
    }
    const cli = body.cli;
    const args = body.args as string[];
    if (args.length > options.requestLimits.maxArgs) {
      return errorResponse(400, "invalid_request", "Too many CLI arguments");
    }
    if (args.some((arg) => Buffer.byteLength(arg) > options.requestLimits.maxArgBytes)) {
      return errorResponse(400, "invalid_request", "CLI argument is too long");
    }

    const authorization = parseTaskToolAuthorization(identity.claims);
    const target = targets.get(cli);
    if (!authorization.restricted || !target) return taskDenied();

    let classified;
    try {
      classified = target.classifier.classify(args);
    } catch (error) {
      if (error instanceof CommandRefusedError) {
        return errorResponse(400, "cli_command_refused", error.message);
      }
      throw error;
    }
    if (target.catalog.commands[classified.command]?.class !== classified.class) {
      return errorResponse(
        400,
        "cli_command_refused",
        "Classified command is absent from the decisions catalog",
      );
    }
    if (!authorization.allows({ provider: "cli", resource: cli, action: classified.class })) {
      return taskDenied();
    }

    let credentialEnv: Readonly<Record<string, string>> | undefined;
    try {
      credentialEnv = await target.credentialEnv?.(identity);
    } catch {
      return errorResponse(503, "credential_unavailable", "CLI credential is unavailable");
    }
    const run = (executionOptions: CliExecutionOptions = {}) =>
      execute(target.runner, args, classified.class, undefined, {
        ...executionOptions,
        credentialEnv,
      });

    if (wait === "full") {
      try {
        const result = await run();
        return Response.json({
          exit_code: result.exit_code,
          stdout: result.stdout,
          stderr: result.stderr,
        });
      } catch {
        return errorResponse(502, "cli_execution_failed", "CLI execution failed");
      }
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let open = true;
        const emit = (event: Record<string, unknown>) => {
          if (!open) return;
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          } catch {
            open = false;
          }
        };
        void run({ onOutput: (type, data) => emit({ type, data }) })
          .then((result) => {
            emit({
              type: "exit",
              exit_code: result.exit_code,
              truncated: result.stdout_truncated || result.stderr_truncated,
            });
          })
          .catch(() => {
            emit({ type: "stderr", data: "CLI execution failed\n" });
            emit({ type: "exit", exit_code: 1, truncated: false });
          })
          .finally(() => {
            if (open) controller.close();
          });
      },
    });
    return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
  };
}

function bearerToken(request: Request): string | undefined {
  const [scheme, token] = request.headers.get("authorization")?.split(" ") ?? [];
  return scheme === "Bearer" && token ? token : undefined;
}

function unauthorized(message: string, challenge: string): Response {
  return errorResponse(401, "unauthorized", message, { "www-authenticate": challenge });
}

function taskDenied(): Response {
  return errorResponse(403, "task_tool_not_approved", "CLI is not approved for this Task");
}

function errorResponse(
  status: number,
  error: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return Response.json({ error, message }, { status, headers });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBoundedJson(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const declaredBytes = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
    return {
      ok: false,
      response: errorResponse(413, "request_too_large", "Request body is too large"),
    };
  }

  if (!request.body) {
    return {
      ok: false,
      response: errorResponse(400, "invalid_request", "Request body must be JSON"),
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
        response: errorResponse(413, "request_too_large", "Request body is too large"),
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
      response: errorResponse(400, "invalid_request", "Request body must be JSON"),
    };
  }
}
