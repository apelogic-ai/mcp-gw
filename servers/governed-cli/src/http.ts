import { randomUUID } from "node:crypto";

import {
  classifyHop1ValidationFailure,
  reportHop1AuthenticationFailure,
  type Hop1Identity,
} from "../../../shared/identity/hop1";
import {
  parseTaskToolAuthorization,
  type TaskToolAuthorization,
  type TaskToolGrant,
} from "../../../packages/wrapper-kit/src/task-tool-authorization";
import type { CliDecisionCatalog } from "./catalog";
import { CommandRefusedError, type CommandClassifier } from "./classifier";
import {
  executeCli,
  type CliExecutionOptions,
  type CliExecutionResult,
  type CliRunnerConfig,
} from "./executor";

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
  jobLimits: {
    maxJobs: number;
    maxRunningJobsPerOwner: number;
    retentionSeconds: number;
  };
  execute?: typeof executeCli;
  now?: () => number;
  jobId?: () => string;
}

type StreamEvent =
  | { type: "stdout" | "stderr"; data: string }
  | { type: "exit"; exit_code: number; truncated: boolean; cancelled?: true };
type JobStatus = "running" | "completed" | "failed" | "cancelled";

interface PreparedRun {
  identity: Hop1Identity;
  target: CliTarget;
  args: string[];
  commandClass: CliExecutionResult["class"];
  grant: TaskToolGrant;
}

interface Job {
  id: string;
  owner: string;
  grant: TaskToolGrant;
  status: JobStatus;
  createdAt: number;
  completedAt?: number;
  result?: CliExecutionResult;
  events: StreamEvent[];
  listeners: Set<(event: StreamEvent) => void>;
  abort: AbortController;
}

const TASK_AUTHORITY_CLAIM = ["ste", "ward"].join("");

export function createCliRunHandler(
  options: CreateCliRunHandlerOptions,
): (request: Request) => Promise<Response> {
  const targets = new Map(options.targets.map((target) => [target.catalog.cli, target]));
  const execute = options.execute ?? executeCli;
  const now = options.now ?? Date.now;
  const nextJobId = options.jobId ?? randomUUID;
  const jobs = new Map<string, Job>();
  let admissions = 0;
  const admissionsByOwner = new Map<string, number>();

  const authenticate = async (
    request: Request,
  ): Promise<
    | { ok: true; identity: Hop1Identity; authorization: TaskToolAuthorization }
    | { ok: false; response: Response }
  > => {
    const token = bearerToken(request);
    if (!token) {
      reportHop1AuthenticationFailure("missing_bearer");
      return { ok: false, response: unauthorized("bearer token is required", "Bearer") };
    }
    try {
      const identity = await options.authenticate(token);
      return {
        ok: true,
        identity,
        authorization: parseTaskToolAuthorization(identity.claims),
      };
    } catch (error) {
      reportHop1AuthenticationFailure(classifyHop1ValidationFailure(error));
      return {
        ok: false,
        response: unauthorized("invalid bearer token", 'Bearer error="invalid_token"'),
      };
    }
  };

  const prepare = async (
    request: Request,
  ): Promise<{ ok: true; run: PreparedRun } | { ok: false; response: Response }> => {
    const authenticated = await authenticate(request);
    if (!authenticated.ok) return authenticated;
    const parsedBody = await readBoundedJson(request, options.requestLimits.maxBodyBytes);
    if (!parsedBody.ok) return parsedBody;
    const body = parsedBody.value;
    if (!isRecord(body) || Object.keys(body).some((key) => !["cli", "args"].includes(key))) {
      return {
        ok: false,
        response: errorResponse(400, "invalid_request", "Only cli and args are supported"),
      };
    }
    if (
      typeof body.cli !== "string" ||
      !Array.isArray(body.args) ||
      body.args.some((arg) => typeof arg !== "string")
    ) {
      return {
        ok: false,
        response: errorResponse(400, "invalid_request", "cli and string-array args are required"),
      };
    }
    const args = body.args as string[];
    if (args.length > options.requestLimits.maxArgs) {
      return {
        ok: false,
        response: errorResponse(400, "invalid_request", "Too many CLI arguments"),
      };
    }
    if (args.some((arg) => Buffer.byteLength(arg) > options.requestLimits.maxArgBytes)) {
      return {
        ok: false,
        response: errorResponse(400, "invalid_request", "CLI argument is too long"),
      };
    }

    const cli = body.cli;
    const target = targets.get(cli);
    if (!authenticated.authorization.restricted || !target) {
      return { ok: false, response: taskDenied() };
    }
    let classified;
    try {
      classified = target.classifier.classify(args);
    } catch (error) {
      if (error instanceof CommandRefusedError) {
        return {
          ok: false,
          response: errorResponse(400, "cli_command_refused", error.message),
        };
      }
      throw error;
    }
    if (target.catalog.commands[classified.command]?.class !== classified.class) {
      return {
        ok: false,
        response: errorResponse(
          400,
          "cli_command_refused",
          "Classified command is absent from the decisions catalog",
        ),
      };
    }
    const grant = { provider: "cli", resource: cli, action: classified.class };
    if (!authenticated.authorization.allows(grant)) {
      return { ok: false, response: taskDenied() };
    }
    return {
      ok: true,
      run: {
        identity: authenticated.identity,
        target,
        args,
        commandClass: classified.class,
        grant,
      },
    };
  };

  const credentials = async (
    run: PreparedRun,
  ): Promise<
    | { ok: true; value: Readonly<Record<string, string>> | undefined }
    | { ok: false; response: Response }
  > => {
    try {
      return { ok: true, value: await run.target.credentialEnv?.(run.identity) };
    } catch {
      return {
        ok: false,
        response: errorResponse(503, "credential_unavailable", "CLI credential is unavailable"),
      };
    }
  };

  const run = (
    prepared: PreparedRun,
    credentialEnv: Readonly<Record<string, string>> | undefined,
    executionOptions: CliExecutionOptions = {},
  ) =>
    execute(prepared.target.runner, prepared.args, prepared.commandClass, undefined, {
      ...executionOptions,
      credentialEnv,
    });

  const prune = (): void => {
    const cutoff = now() - options.jobLimits.retentionSeconds * 1000;
    for (const [id, job] of jobs) {
      if (job.completedAt !== undefined && job.completedAt <= cutoff) jobs.delete(id);
    }
  };

  const admit = (owner: string): boolean => {
    prune();
    const ownerRunning = [...jobs.values()].filter(
      (job) => job.owner === owner && job.status === "running",
    ).length;
    if (
      ownerRunning + (admissionsByOwner.get(owner) ?? 0) >=
      options.jobLimits.maxRunningJobsPerOwner
    ) {
      return false;
    }
    while (jobs.size + admissions >= options.jobLimits.maxJobs) {
      const oldestFinished = [...jobs.values()]
        .filter((job) => job.completedAt !== undefined)
        .sort((left, right) => (left.completedAt ?? 0) - (right.completedAt ?? 0))[0];
      if (!oldestFinished) return false;
      jobs.delete(oldestFinished.id);
    }
    admissions += 1;
    admissionsByOwner.set(owner, (admissionsByOwner.get(owner) ?? 0) + 1);
    return true;
  };

  const releaseAdmission = (owner: string): void => {
    admissions -= 1;
    const remaining = (admissionsByOwner.get(owner) ?? 1) - 1;
    if (remaining) admissionsByOwner.set(owner, remaining);
    else admissionsByOwner.delete(owner);
  };

  const emit = (job: Job, event: StreamEvent): void => {
    if (event.type === "stdout" || event.type === "stderr") {
      const previous = job.events.at(-1);
      if (previous?.type === event.type) previous.data += event.data;
      else job.events.push({ ...event });
    } else {
      job.events.push(event);
    }
    for (const listener of job.listeners) listener(event);
  };

  const finish = (
    job: Job,
    status: Exclude<JobStatus, "running">,
    result: CliExecutionResult,
    event: Extract<StreamEvent, { type: "exit" }>,
  ): void => {
    if (job.status !== "running") return;
    job.status = status;
    job.result = result;
    job.completedAt = now();
    emit(job, event);
    job.listeners.clear();
  };

  const startJob = (
    prepared: PreparedRun,
    owner: string,
    credentialEnv: Readonly<Record<string, string>> | undefined,
  ): Job => {
    const job: Job = {
      id: nextJobId(),
      owner,
      grant: prepared.grant,
      status: "running",
      createdAt: now(),
      events: [],
      listeners: new Set(),
      abort: new AbortController(),
    };
    jobs.set(job.id, job);
    void Promise.resolve()
      .then(() =>
        run(prepared, credentialEnv, {
          signal: job.abort.signal,
          onOutput: (type, data) => emit(job, { type, data }),
        }),
      )
      .then((result) =>
        finish(job, "completed", result, {
          type: "exit",
          exit_code: result.exit_code,
          truncated: result.stdout_truncated || result.stderr_truncated,
        }),
      )
      .catch(() => {
        const cancelled = job.abort.signal.aborted;
        const message = cancelled ? "CLI execution cancelled\n" : "CLI execution failed\n";
        emit(job, { type: "stderr", data: message });
        finish(
          job,
          cancelled ? "cancelled" : "failed",
          {
            exit_code: cancelled ? 130 : 1,
            stdout: "",
            stderr: message,
            stdout_truncated: false,
            stderr_truncated: false,
            duration_ms: now() - job.createdAt,
            class: prepared.commandClass,
          },
          {
            type: "exit",
            exit_code: cancelled ? 130 : 1,
            truncated: false,
            ...(cancelled ? { cancelled: true as const } : {}),
          },
        );
      });
    return job;
  };

  const jobFor = (
    id: string,
    identity: Hop1Identity,
    authorization: TaskToolAuthorization,
  ): Job | undefined => {
    prune();
    const job = jobs.get(id);
    const owner = taskOwner(identity);
    return job && owner === job.owner && authorization.allows(job.grant) ? job : undefined;
  };

  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/cli/run") {
      if (request.method !== "POST") {
        return errorResponse(405, "method_not_allowed", "POST is required");
      }
      const wait = url.searchParams.get("wait");
      if (wait !== null && wait !== "full") {
        return errorResponse(400, "invalid_request", "Only wait=full is supported");
      }
      const prepared = await prepare(request);
      if (!prepared.ok) return prepared.response;
      const credentialEnv = await credentials(prepared.run);
      if (!credentialEnv.ok) return credentialEnv.response;
      if (wait === "full") {
        try {
          const result = await run(prepared.run, credentialEnv.value, { signal: request.signal });
          return Response.json({
            exit_code: result.exit_code,
            stdout: result.stdout,
            stderr: result.stderr,
          });
        } catch {
          return errorResponse(502, "cli_execution_failed", "CLI execution failed");
        }
      }
      return directStream(request, (executionOptions) =>
        run(prepared.run, credentialEnv.value, executionOptions),
      );
    }

    if (url.pathname === "/cli/jobs") {
      if (request.method !== "POST") {
        return errorResponse(405, "method_not_allowed", "POST is required");
      }
      const prepared = await prepare(request);
      if (!prepared.ok) return prepared.response;
      const owner = taskOwner(prepared.run.identity);
      if (!owner) return taskDenied();
      if (!admit(owner)) {
        return errorResponse(503, "job_capacity_exceeded", "CLI job capacity is exhausted");
      }
      try {
        const credentialEnv = await credentials(prepared.run);
        if (!credentialEnv.ok) return credentialEnv.response;
        const job = startJob(prepared.run, owner, credentialEnv.value);
        return Response.json({ job_id: job.id, status: job.status }, { status: 202 });
      } finally {
        releaseAdmission(owner);
      }
    }

    const match = /^\/cli\/jobs\/([^/]+)(?:\/(stream|cancel))?$/.exec(url.pathname);
    if (!match) return errorResponse(404, "not_found", "Not found");
    const action = match[2];
    const expectedMethod = action === "cancel" ? "POST" : "GET";
    if (request.method !== expectedMethod) {
      return errorResponse(405, "method_not_allowed", `${expectedMethod} is required`);
    }
    const authenticated = await authenticate(request);
    if (!authenticated.ok) return authenticated.response;
    const job = jobFor(match[1] ?? "", authenticated.identity, authenticated.authorization);
    if (!job) return errorResponse(404, "not_found", "Not found");
    if (action === "stream") return jobStream(job);
    if (action === "cancel") {
      if (job.status === "running") job.abort.abort();
      return Response.json({ job_id: job.id, status: job.status }, { status: 202 });
    }
    return Response.json(jobView(job));
  };
}

function directStream(
  request: Request,
  run: (options: CliExecutionOptions) => Promise<CliExecutionResult>,
): Response {
  const encoder = new TextEncoder();
  const abort = new AbortController();
  let open = true;
  const disconnect = () => abort.abort();
  if (request.signal.aborted) abort.abort();
  else request.signal.addEventListener("abort", disconnect, { once: true });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (event: StreamEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          open = false;
          abort.abort();
        }
      };
      void run({ signal: abort.signal, onOutput: (type, data) => emit({ type, data }) })
        .then((result) =>
          emit({
            type: "exit",
            exit_code: result.exit_code,
            truncated: result.stdout_truncated || result.stderr_truncated,
          }),
        )
        .catch(() => {
          if (abort.signal.aborted) return;
          emit({ type: "stderr", data: "CLI execution failed\n" });
          emit({ type: "exit", exit_code: 1, truncated: false });
        })
        .finally(() => {
          request.signal.removeEventListener("abort", disconnect);
          if (open) controller.close();
        });
    },
    cancel() {
      open = false;
      abort.abort();
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
}

function jobStream(job: Job): Response {
  const encoder = new TextEncoder();
  let listener: ((event: StreamEvent) => void) | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const write = (event: StreamEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          open = false;
          if (listener) job.listeners.delete(listener);
        }
        if (event.type === "exit" && open) {
          open = false;
          controller.close();
        }
      };
      for (const event of job.events) write(event);
      if (job.status === "running") {
        listener = write;
        job.listeners.add(listener);
      }
    },
    cancel() {
      if (listener) job.listeners.delete(listener);
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
}

function jobView(job: Job): Record<string, unknown> {
  return {
    job_id: job.id,
    status: job.status,
    created_at: new Date(job.createdAt).toISOString(),
    ...(job.completedAt === undefined
      ? {}
      : { completed_at: new Date(job.completedAt).toISOString(), result: job.result }),
  };
}

function taskOwner(identity: Hop1Identity): string | undefined {
  const authority = identity.claims[TASK_AUTHORITY_CLAIM];
  if (!isRecord(authority) || typeof authority.runtime_uid !== "string") return undefined;
  const runtimeUid = authority.runtime_uid.trim();
  return runtimeUid ? JSON.stringify([identity.issuer, identity.subject, runtimeUid]) : undefined;
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
