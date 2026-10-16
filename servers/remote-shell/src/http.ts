import { createHash } from "node:crypto";

import type { Hop1Identity } from "../../../shared/identity/hop1";
import {
  authenticateTaskRequest,
  jsonError,
  ndjsonResponse,
  readBoundedJson,
  taskOwner,
} from "../../../packages/wrapper-kit/src/governed-http";
import type { TaskToolAuthorization } from "../../../packages/wrapper-kit/src/task-tool-authorization";
import {
  SsmRunCommandError,
  type SsmCommandJob,
  type SsmRunCommand,
  type SsmRunRequest,
  type SsmRunResult,
} from "./ssm-run-command";

export const REMOTE_SHELL_GRANT = {
  provider: "remote-shell",
  resource: "remote_shell_run",
  action: "write",
} as const;

const ROLE_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const MIN_TIMEOUT_SECONDS = 10;
const TASK_AUTHORITY_CLAIM = ["ste", "ward"].join("");

export interface RemoteShellBinding {
  issuer: string;
  subject: string;
  targets: Record<string, string>;
}

export interface RemoteShellAuditEvent extends Record<
  string,
  string | number | boolean | undefined
> {
  category: "remote_shell_command";
  ts: string;
  status: "allow" | "deny" | "error";
  principal: string;
}

export interface RemoteShellAuditSink {
  emit(event: RemoteShellAuditEvent): Promise<void>;
}

export interface CreateRemoteShellHttpHandlerOptions {
  authenticate(token: string): Promise<Hop1Identity>;
  bindings: readonly RemoteShellBinding[];
  maxTimeoutSeconds: number;
  requestLimits: { maxBodyBytes: number; maxCommandBytes: number };
  jobLimits: {
    maxJobs: number;
    maxRunningJobsPerOwner: number;
    retentionSeconds: number;
  };
  ssm: SsmRunCommand;
  audit?: RemoteShellAuditSink;
  now?: () => number;
}

interface PreparedRun {
  identity: Hop1Identity;
  owner: string;
  runtimeUid: string;
  targetRole: string;
  command: string;
  request: SsmRunRequest;
}

type JobStatus = "running" | "cancelling" | "completed" | "failed" | "cancelled";

interface RemoteShellJob {
  id: string;
  owner: string;
  prepared: PreparedRun;
  ssm: SsmCommandJob;
  status: JobStatus;
  createdAt: number;
  completedAt?: number;
  result?: SsmRunResult;
}

export function createRemoteShellHttpHandler(
  options: CreateRemoteShellHttpHandlerOptions,
): (request: Request) => Promise<Response> {
  const now = options.now ?? Date.now;
  const jobs = new Map<string, RemoteShellJob>();
  let admissions = 0;
  const admissionsByOwner = new Map<string, number>();

  const prepare = async (
    request: Request,
  ): Promise<{ ok: true; run: PreparedRun } | { ok: false; response: Response }> => {
    const authenticated = await authenticateTaskRequest(request, (token) =>
      options.authenticate(token),
    );
    if (!authenticated.ok) return authenticated;
    const runtimeUid = taskRuntimeUid(authenticated.identity);
    const owner = taskOwner(authenticated.identity);
    const binding = options.bindings.find(
      (candidate) =>
        candidate.issuer === authenticated.identity.issuer &&
        candidate.subject === authenticated.identity.subject,
    );
    if (
      !authenticated.authorization.restricted ||
      !authenticated.authorization.allows(REMOTE_SHELL_GRANT) ||
      !runtimeUid ||
      !owner ||
      !binding
    ) {
      await emit(
        options.audit,
        auditEvent("deny", authenticated.identity, runtimeUid, "task_tool_not_approved"),
      );
      return { ok: false, response: taskDenied() };
    }
    const parsedBody = await readBoundedJson(request, options.requestLimits.maxBodyBytes);
    if (!parsedBody.ok) return parsedBody;
    const parsed = parseRunRequest(
      parsedBody.value,
      options.maxTimeoutSeconds,
      options.requestLimits.maxCommandBytes,
    );
    if (!parsed.ok) {
      await emit(
        options.audit,
        auditEvent(
          "deny",
          authenticated.identity,
          runtimeUid,
          parsed.error,
          parsed.target,
          parsed.command,
        ),
      );
      return {
        ok: false,
        response: jsonError(400, "remote_shell_invalid_arguments", parsed.error),
      };
    }
    const instanceId = binding.targets[parsed.target];
    if (!instanceId) {
      await emit(
        options.audit,
        auditEvent(
          "deny",
          authenticated.identity,
          runtimeUid,
          "target_not_bound",
          parsed.target,
          parsed.command,
        ),
      );
      return {
        ok: false,
        response: jsonError(403, "remote_shell_target_not_bound", "Target role is not bound"),
      };
    }
    return {
      ok: true,
      run: {
        identity: authenticated.identity,
        owner,
        runtimeUid,
        targetRole: parsed.target,
        command: parsed.command,
        request: {
          instanceId,
          runtimeUid,
          command: parsed.command,
          timeoutSeconds: parsed.timeoutSeconds,
        },
      },
    };
  };

  const complete = async (job: RemoteShellJob, result: SsmRunResult): Promise<void> => {
    if (job.status !== "running" && job.status !== "cancelling") return;
    job.status = job.status === "cancelling" ? "cancelled" : "completed";
    job.result = result;
    job.completedAt = now();
    await emit(options.audit, runEvent("allow", job.prepared, { exit_code: result.exit_code }));
  };

  const fail = async (job: RemoteShellJob): Promise<void> => {
    if (job.status !== "running" && job.status !== "cancelling") return;
    job.status = job.status === "cancelling" ? "cancelled" : "failed";
    job.completedAt = now();
    await emit(options.audit, runEvent("error", job.prepared));
  };

  const startWait = (job: RemoteShellJob): void => {
    void options.ssm
      .wait(job.ssm)
      .then((result) => complete(job, result))
      .catch(() => fail(job));
  };

  const prune = (): void => {
    const cutoff = now() - options.jobLimits.retentionSeconds * 1000;
    for (const [id, job] of jobs) {
      if (job.completedAt !== undefined && job.completedAt <= cutoff) jobs.delete(id);
    }
  };

  const admit = (owner: string): boolean => {
    prune();
    const ownerRunning = [...jobs.values()].filter(
      (job) => job.owner === owner && (job.status === "running" || job.status === "cancelling"),
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

  const findJob = (
    id: string,
    identity: Hop1Identity,
    authorization: TaskToolAuthorization,
  ): RemoteShellJob | undefined => {
    prune();
    const owner = taskOwner(identity);
    const job = jobs.get(id);
    return owner &&
      authorization.restricted &&
      authorization.allows(REMOTE_SHELL_GRANT) &&
      job?.owner === owner
      ? job
      : undefined;
  };

  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/shell/run") {
      if (request.method !== "POST") {
        return jsonError(405, "method_not_allowed", "POST is required");
      }
      const wait = url.searchParams.get("wait");
      if (wait !== null && wait !== "full") {
        return jsonError(400, "invalid_request", "Only wait=full is supported");
      }
      const prepared = await prepare(request);
      if (!prepared.ok) return prepared.response;
      try {
        const result = await options.ssm(prepared.run.request);
        await emit(options.audit, runEvent("allow", prepared.run, { exit_code: result.exit_code }));
        return wait === "full" ? Response.json(publicResult(result)) : resultNdjson(result);
      } catch (error) {
        return await executionFailure(options.audit, prepared.run, error);
      }
    }

    if (url.pathname === "/shell/jobs") {
      if (request.method !== "POST") {
        return jsonError(405, "method_not_allowed", "POST is required");
      }
      const prepared = await prepare(request);
      if (!prepared.ok) return prepared.response;
      if (!admit(prepared.run.owner)) {
        return jsonError(503, "job_capacity_exceeded", "Remote shell job capacity is exhausted");
      }
      try {
        const ssm = await options.ssm.start(prepared.run.request);
        if (jobs.has(ssm.commandId)) {
          return jsonError(502, "remote_shell_execution_failed", "Remote command execution failed");
        }
        const job: RemoteShellJob = {
          id: ssm.commandId,
          owner: prepared.run.owner,
          prepared: prepared.run,
          ssm,
          status: "running",
          createdAt: now(),
        };
        jobs.set(job.id, job);
        startWait(job);
        return Response.json({ job_id: job.id, status: job.status }, { status: 202 });
      } catch (error) {
        return await executionFailure(options.audit, prepared.run, error);
      } finally {
        releaseAdmission(prepared.run.owner);
      }
    }

    const match = /^\/shell\/jobs\/([^/]+)(?:\/(cancel))?$/.exec(url.pathname);
    if (!match) return jsonError(404, "not_found", "Not found");
    const action = match[2];
    const expectedMethod = action === "cancel" ? "POST" : "GET";
    if (request.method !== expectedMethod) {
      return jsonError(405, "method_not_allowed", `${expectedMethod} is required`);
    }
    const authenticated = await authenticateTaskRequest(request, (token) =>
      options.authenticate(token),
    );
    if (!authenticated.ok) return authenticated.response;
    const job = findJob(match[1] ?? "", authenticated.identity, authenticated.authorization);
    if (!job) return jsonError(404, "not_found", "Not found");
    if (action === "cancel" && job.status === "running") {
      try {
        await options.ssm.cancel(job.ssm);
        job.status = "cancelling";
      } catch {
        return jsonError(502, "remote_shell_execution_failed", "Remote command execution failed");
      }
    }
    return action === "cancel"
      ? Response.json({ job_id: job.id, status: job.status }, { status: 202 })
      : Response.json(jobView(job));
  };
}

type ParsedRun =
  | { ok: true; target: string; command: string; timeoutSeconds: number }
  | { ok: false; error: string; target?: string; command?: string };

function parseRunRequest(
  value: unknown,
  maxTimeoutSeconds: number,
  maxCommandBytes: number,
): ParsedRun {
  if (!isRecord(value)) return { ok: false, error: "Request body must be an object" };
  const target = typeof value.target === "string" ? value.target : undefined;
  const command = typeof value.command === "string" ? value.command : undefined;
  if (Object.keys(value).some((key) => !["target", "command", "timeout_seconds"].includes(key))) {
    return { ok: false, error: "Unsupported argument", target, command };
  }
  if (!target || !ROLE_PATTERN.test(target)) {
    return { ok: false, error: "Target must be a platform-defined role", target, command };
  }
  if (!command || Buffer.byteLength(command) > maxCommandBytes) {
    return { ok: false, error: "Command must be non-empty and within the size limit", target };
  }
  const timeout = value.timeout_seconds ?? maxTimeoutSeconds;
  if (
    !Number.isSafeInteger(timeout) ||
    (timeout as number) < MIN_TIMEOUT_SECONDS ||
    (timeout as number) > maxTimeoutSeconds
  ) {
    return { ok: false, error: "Timeout is outside the configured limit", target, command };
  }
  return { ok: true, target, command, timeoutSeconds: timeout as number };
}

async function executionFailure(
  audit: RemoteShellAuditSink | undefined,
  run: PreparedRun,
  error: unknown,
): Promise<Response> {
  if (error instanceof SsmRunCommandError && error.code === "target_not_run_bound") {
    await emit(audit, runEvent("deny", run, { error: "remote_shell_target_not_run_bound" }));
    return jsonError(403, "remote_shell_target_not_run_bound", "Target is not bound to this run");
  }
  await emit(audit, runEvent("error", run));
  return jsonError(502, "remote_shell_execution_failed", "Remote command execution failed");
}

function resultNdjson(result: SsmRunResult): Response {
  return ndjsonResponse([
    ...(result.stdout ? [{ type: "stdout", data: result.stdout }] : []),
    ...(result.stderr ? [{ type: "stderr", data: result.stderr }] : []),
    {
      type: "exit",
      exit_code: result.exit_code,
      truncated: result.stdout_truncated || result.stderr_truncated,
    },
  ]);
}

function publicResult(result: SsmRunResult) {
  return { exit_code: result.exit_code, stdout: result.stdout, stderr: result.stderr };
}

function jobView(job: RemoteShellJob): Record<string, unknown> {
  return {
    job_id: job.id,
    status: job.status,
    created_at: new Date(job.createdAt).toISOString(),
    ...(job.completedAt === undefined
      ? {}
      : {
          completed_at: new Date(job.completedAt).toISOString(),
          ...(job.result ? { result: publicResult(job.result) } : {}),
        }),
  };
}

function runEvent(
  status: RemoteShellAuditEvent["status"],
  run: PreparedRun,
  details: { error?: string; exit_code?: number } = status === "error"
    ? { error: "remote_shell_execution_failed" }
    : {},
): RemoteShellAuditEvent {
  return auditEvent(
    status,
    run.identity,
    run.runtimeUid,
    details.error,
    run.targetRole,
    run.command,
    details,
  );
}

function auditEvent(
  status: RemoteShellAuditEvent["status"],
  identity: Hop1Identity,
  runtimeUid: string | undefined,
  error?: string,
  target?: string,
  command?: string,
  details: { error?: string; exit_code?: number } = { error },
): RemoteShellAuditEvent {
  return {
    category: "remote_shell_command",
    ts: new Date().toISOString(),
    status,
    principal: principal(identity),
    ...(runtimeUid ? { runtime_uid: runtimeUid } : {}),
    ...(target ? { target_role: ROLE_PATTERN.test(target) ? target : "invalid" } : {}),
    ...(command ? { command_digest: commandDigest(command) } : {}),
    ...details,
  };
}

function taskDenied(): Response {
  return jsonError(403, "task_tool_not_approved", "Remote shell is not approved for this Task");
}

function taskRuntimeUid(identity: Hop1Identity): string | undefined {
  const authority = identity.claims[TASK_AUTHORITY_CLAIM];
  if (!isRecord(authority) || typeof authority.runtime_uid !== "string") return undefined;
  const value = authority.runtime_uid.trim();
  return value || undefined;
}

function principal(identity: Hop1Identity): string {
  return `${identity.issuer}#${identity.subject}`;
}

function commandDigest(command: string): string {
  return createHash("sha256").update(command).digest("hex");
}

async function emit(
  sink: RemoteShellAuditSink | undefined,
  event: RemoteShellAuditEvent,
): Promise<void> {
  try {
    await sink?.emit(event);
  } catch {
    // Audit failures must not expose command data or change authorization decisions.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
