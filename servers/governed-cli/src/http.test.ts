import { describe, expect, test } from "bun:test";
import type { Hop1Identity } from "../../../shared/identity/hop1";
import { taskAuthority, withTaskAuthority } from "../../../test/support/task-authority-fixture";
import { CLI_DECISIONS_SCHEMA, parseCliDecisionCatalog } from "./catalog";
import { CommandRefusedError } from "./classifier";
import type { CliExecutionOptions, CliExecutionResult } from "./executor";
import { createCliRunHandler, type CliTarget } from "./http";

const catalog = parseCliDecisionCatalog(`
schemaVersion: ${CLI_DECISIONS_SCHEMA}
cli: fixture
commands:
  inspect:
    class: read
  reveal:
    class: secret-read
`);

const target: CliTarget = {
  catalog,
  runner: {
    binary: "/opt/fixture",
    env: { PATH: "/fixed/bin" },
    cwd: "/runner",
    defaultTimeoutSeconds: 30,
    maxTimeoutSeconds: 60,
    maxOutputBytes: 1024,
  },
  classifier: {
    classify(args) {
      const command = args[0];
      const decision = command ? catalog.commands[command] : undefined;
      if (!command || !decision) throw new CommandRefusedError("fixture command is not approved");
      return { command, class: decision.class };
    },
  },
};

const requestLimits = {
  maxBodyBytes: 64 * 1024,
  maxArgs: 64,
  maxArgBytes: 4 * 1024,
};
const jobLimits = { maxJobs: 8, maxRunningJobsPerOwner: 4, retentionSeconds: 60 };

function identity(
  actions: string[],
  restricted = true,
  runtimeUid = "runtime-uid-a",
): Hop1Identity {
  return {
    profile: "test",
    issuer: "https://identity.example.com",
    subject: "subject",
    email: "person@example.com",
    claims: restricted
      ? withTaskAuthority({
          ...taskAuthority,
          runtime_uid: runtimeUid,
          tools: actions.map((action) => ({ provider: "cli", resource: "fixture", action })),
        })
      : {},
  };
}

function request(body: unknown, query = ""): Request {
  return new Request(`http://localhost/cli/run${query}`, {
    method: "POST",
    headers: { authorization: "Bearer run-token", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function apiRequest(
  path: string,
  options: { method?: string; body?: unknown; token?: string } = {},
): Request {
  return new Request(`http://localhost${path}`, {
    method: options.method ?? "GET",
    headers: {
      authorization: `Bearer ${options.token ?? "run-token"}`,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

describe("governed CLI HTTP", () => {
  test("requires a valid restricted Task token and exact class grant before credentials or spawn", async () => {
    let credentials = 0;
    let executions = 0;
    const handler = createCliRunHandler({
      authenticate: () => Promise.resolve(identity(["read"])),
      requestLimits,
      jobLimits,
      targets: [
        {
          ...target,
          credentialEnv: () => {
            credentials += 1;
            return Promise.resolve({ RUNNER_TOKEN: "provider-secret" });
          },
        },
      ],
      execute: () => {
        executions += 1;
        throw new Error("must not execute");
      },
    });

    expect(
      await handler(new Request("http://localhost/cli/run", { method: "POST" })),
    ).toMatchObject({ status: 401 });
    expect(await handler(request({ cli: "fixture", args: ["reveal"] }))).toMatchObject({
      status: 403,
    });
    expect(await handler(request({ cli: "other", args: ["inspect"] }))).toMatchObject({
      status: 403,
    });

    const interactive = createCliRunHandler({
      authenticate: () => Promise.resolve(identity([], false)),
      requestLimits,
      jobLimits,
      targets: [target],
      execute: () => {
        executions += 1;
        throw new Error("must not execute");
      },
    });
    expect(await interactive(request({ cli: "fixture", args: ["inspect"] }))).toMatchObject({
      status: 403,
    });
    expect([credentials, executions]).toEqual([0, 0]);
  });

  test("refuses unknown commands and request-controlled process settings", async () => {
    let executions = 0;
    const handler = createCliRunHandler({
      authenticate: () => Promise.resolve(identity(["read"])),
      requestLimits,
      jobLimits,
      targets: [target],
      execute: () => {
        executions += 1;
        throw new Error("must not execute");
      },
    });

    expect(await handler(request({ cli: "fixture", args: ["unknown"] }))).toMatchObject({
      status: 400,
    });
    for (const extra of [
      { env: { RUNNER_TOKEN: "attacker" } },
      { cwd: "/attacker" },
      { stdin: "data" },
    ]) {
      expect(await handler(request({ cli: "fixture", args: ["inspect"], ...extra }))).toMatchObject(
        { status: 400 },
      );
    }
    expect(executions).toBe(0);
  });

  test("refuses oversized bodies and argument vectors before classification", async () => {
    let classifications = 0;
    const handler = createCliRunHandler({
      authenticate: () => Promise.resolve(identity(["read"])),
      requestLimits: { maxBodyBytes: 64, maxArgs: 2, maxArgBytes: 8 },
      jobLimits,
      targets: [
        {
          ...target,
          classifier: {
            classify(args) {
              classifications += 1;
              return target.classifier.classify(args);
            },
          },
        },
      ],
    });

    const declaredOversize = request({ cli: "fixture", args: ["inspect"] });
    declaredOversize.headers.set("content-length", "65");
    expect(await handler(declaredOversize)).toMatchObject({ status: 413 });
    expect(
      await handler(request({ cli: "fixture", args: ["inspect", "x".repeat(65)] })),
    ).toMatchObject({ status: 413 });
    expect(await handler(request({ cli: "fixture", args: ["inspect", "x", "y"] }))).toMatchObject({
      status: 400,
    });
    expect(
      await handler(request({ cli: "fixture", args: ["inspect", "123456789"] })),
    ).toMatchObject({ status: 400 });
    expect(classifications).toBe(0);
  });

  test("streams NDJSON output and a single final exit event", async () => {
    const calls: unknown[] = [];
    const handler = createCliRunHandler({
      authenticate: () => Promise.resolve(identity(["read"])),
      requestLimits,
      jobLimits,
      targets: [
        {
          ...target,
          credentialEnv: () => Promise.resolve({ RUNNER_TOKEN: "provider-secret" }),
        },
      ],
      execute: (config, args, commandClass, timeout, options) => {
        if (!options) throw new Error("missing execution options");
        calls.push({ config, args, commandClass, timeout, credentialEnv: options.credentialEnv });
        options.onOutput?.("stdout", "first\n");
        options.onOutput?.("stderr", "warning\n");
        options.onOutput?.("stdout", "last\n");
        return Promise.resolve({
          exit_code: 7,
          stdout: "first\nlast\n",
          stderr: "warning\n",
          stdout_truncated: true,
          stderr_truncated: false,
          duration_ms: 1,
          class: commandClass,
        });
      },
    });

    const response = await handler(
      request({ cli: "fixture", args: ["inspect", ";", "|", "$(x)"] }),
    );
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    expect(
      (await response.text())
        .trim()
        .split("\n")
        .map((line): unknown => JSON.parse(line) as unknown),
    ).toEqual([
      { type: "stdout", data: "first\n" },
      { type: "stderr", data: "warning\n" },
      { type: "stdout", data: "last\n" },
      { type: "exit", exit_code: 7, truncated: true },
    ]);
    expect(calls).toEqual([
      {
        config: target.runner,
        args: ["inspect", ";", "|", "$(x)"],
        commandClass: "read",
        timeout: undefined,
        credentialEnv: { RUNNER_TOKEN: "provider-secret" },
      },
    ]);
    expect(JSON.stringify(calls)).not.toContain("run-token");
  });

  test("returns one combined response for wait=full", async () => {
    const handler = createCliRunHandler({
      authenticate: () => Promise.resolve(identity(["read"])),
      requestLimits,
      jobLimits,
      targets: [target],
      execute: (_config, _args, commandClass, _timeout, options) => {
        if (!options) throw new Error("missing execution options");
        expect(options.onOutput).toBeUndefined();
        return Promise.resolve({
          exit_code: 0,
          stdout: "complete",
          stderr: "",
          stdout_truncated: false,
          stderr_truncated: false,
          duration_ms: 1,
          class: commandClass,
        });
      },
    });

    expect(
      await (await handler(request({ cli: "fixture", args: ["inspect"] }, "?wait=full"))).json(),
    ).toEqual({ exit_code: 0, stdout: "complete", stderr: "" });
  });

  test("aborts a streamed direct run when its reader disconnects", async () => {
    let signal: AbortSignal | undefined;
    const handler = createCliRunHandler({
      authenticate: () => Promise.resolve(identity(["read"])),
      requestLimits,
      jobLimits,
      targets: [target],
      execute: (_config, _args, _commandClass, _timeout, options) =>
        new Promise((_resolve, reject) => {
          signal = options?.signal;
          options?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), {
            once: true,
          });
        }),
    });

    const response = await handler(request({ cli: "fixture", args: ["inspect"] }));
    await response.body?.getReader().cancel();
    expect(signal?.aborted).toBe(true);
  });

  test("runs an async job with replay plus live output and one final event", async () => {
    let executionOptions: CliExecutionOptions | undefined;
    let complete: ((result: CliExecutionResult) => void) | undefined;
    const handler = createCliRunHandler({
      authenticate: () => Promise.resolve(identity(["read"])),
      requestLimits,
      jobLimits,
      jobId: () => "job-1",
      now: () => Date.parse("2026-10-15T12:00:00Z"),
      targets: [target],
      execute: (_config, _args, _commandClass, _timeout, options) => {
        executionOptions = options;
        return new Promise((resolve) => {
          complete = resolve;
        });
      },
    });
    const created = await handler(
      apiRequest("/cli/jobs", {
        method: "POST",
        body: { cli: "fixture", args: ["inspect", ";", "|", "$(x)"] },
      }),
    );
    expect(created.status).toBe(202);
    expect(await created.json()).toEqual({ job_id: "job-1", status: "running" });
    await Bun.sleep(0);
    executionOptions?.onOutput?.("stdout", "first\n");

    const running = await (await handler(apiRequest("/cli/jobs/job-1"))).json();
    expect(running).toMatchObject({ job_id: "job-1", status: "running" });
    const streaming = await handler(apiRequest("/cli/jobs/job-1/stream"));
    const streamed = streaming.text();
    executionOptions?.onOutput?.("stderr", "warning\n");
    complete?.({
      exit_code: 7,
      stdout: "first\n",
      stderr: "warning\n",
      stdout_truncated: true,
      stderr_truncated: false,
      duration_ms: 25,
      class: "read",
    });

    expect(
      (await streamed)
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as unknown),
    ).toEqual([
      { type: "stdout", data: "first\n" },
      { type: "stderr", data: "warning\n" },
      { type: "exit", exit_code: 7, truncated: true },
    ]);
    expect(await (await handler(apiRequest("/cli/jobs/job-1"))).json()).toMatchObject({
      status: "completed",
      result: { exit_code: 7, stdout: "first\n", stderr: "warning\n", class: "read" },
    });
  });

  test("hides jobs from a different Task runtime and cancels without exposing failures", async () => {
    let signal: AbortSignal | undefined;
    const handler = createCliRunHandler({
      authenticate: (token) =>
        Promise.resolve(
          identity(["read"], true, token === "foreign" ? "runtime-uid-b" : "runtime-uid-a"),
        ),
      requestLimits,
      jobLimits,
      jobId: () => "job-private",
      targets: [
        {
          ...target,
          credentialEnv: () => Promise.resolve({ RUNNER_TOKEN: "provider-secret" }),
        },
      ],
      execute: (_config, _args, _commandClass, _timeout, options) =>
        new Promise((_resolve, reject) => {
          signal = options?.signal;
          options?.signal?.addEventListener("abort", () => reject(new Error("provider-secret")), {
            once: true,
          });
        }),
    });
    await handler(
      apiRequest("/cli/jobs", {
        method: "POST",
        body: { cli: "fixture", args: ["inspect"] },
      }),
    );
    await Bun.sleep(0);

    const detached = await handler(apiRequest("/cli/jobs/job-private/stream"));
    await detached.body?.getReader().cancel();
    expect(signal?.aborted).toBe(false);

    for (const suffix of ["", "/stream", "/cancel"]) {
      expect(
        await handler(
          apiRequest(`/cli/jobs/job-private${suffix}`, {
            method: suffix === "/cancel" ? "POST" : "GET",
            token: "foreign",
          }),
        ),
      ).toMatchObject({ status: 404 });
    }
    const cancelled = await handler(apiRequest("/cli/jobs/job-private/cancel", { method: "POST" }));
    expect(cancelled.status).toBe(202);
    expect(signal?.aborted).toBe(true);
    await Bun.sleep(0);
    const view = JSON.stringify(await (await handler(apiRequest("/cli/jobs/job-private"))).json());
    const replay = await (await handler(apiRequest("/cli/jobs/job-private/stream"))).text();
    expect(view).toContain('"status":"cancelled"');
    expect(replay.match(/"type":"exit"/g)).toHaveLength(1);
    expect(`${view}${replay}`).not.toContain("provider-secret");
  });

  test("limits running jobs per owner without blocking another Task", async () => {
    let credentials = 0;
    const handler = createCliRunHandler({
      authenticate: (token) =>
        Promise.resolve(
          identity(["read"], true, token === "other" ? "runtime-uid-b" : "runtime-uid-a"),
        ),
      requestLimits,
      jobLimits: { maxJobs: 3, maxRunningJobsPerOwner: 1, retentionSeconds: 60 },
      targets: [
        {
          ...target,
          credentialEnv: () => {
            credentials += 1;
            return Promise.resolve({});
          },
        },
      ],
      execute: () => new Promise(() => undefined),
    });
    const create = (token = "run-token") =>
      handler(
        apiRequest("/cli/jobs", {
          method: "POST",
          body: { cli: "fixture", args: ["inspect"] },
          token,
        }),
      );

    expect(await create()).toMatchObject({ status: 202 });
    expect(await create()).toMatchObject({ status: 503 });
    expect(await create("other")).toMatchObject({ status: 202 });
    expect(credentials).toBe(2);
  });

  test("evicts finished jobs but refuses when running jobs fill global capacity", async () => {
    let credentials = 0;
    let executions = 0;
    let nextId = 0;
    const handler = createCliRunHandler({
      authenticate: (token) =>
        Promise.resolve(
          identity(["read"], true, token === "other" ? "runtime-uid-b" : "runtime-uid-a"),
        ),
      requestLimits,
      jobLimits: { maxJobs: 1, maxRunningJobsPerOwner: 1, retentionSeconds: 60 },
      jobId: () => `job-${String(++nextId)}`,
      targets: [
        {
          ...target,
          credentialEnv: () => {
            credentials += 1;
            return Promise.resolve({});
          },
        },
      ],
      execute: (_config, _args, commandClass) => {
        executions += 1;
        if (executions > 1) return new Promise(() => undefined);
        return Promise.resolve({
          exit_code: 0,
          stdout: "",
          stderr: "",
          stdout_truncated: false,
          stderr_truncated: false,
          duration_ms: 1,
          class: commandClass,
        });
      },
    });
    const create = (token = "run-token") =>
      handler(
        apiRequest("/cli/jobs", {
          method: "POST",
          body: { cli: "fixture", args: ["inspect"] },
          token,
        }),
      );

    expect(await create()).toMatchObject({ status: 202 });
    await Bun.sleep(0);
    expect(await create()).toMatchObject({ status: 202 });
    expect(await handler(apiRequest("/cli/jobs/job-1"))).toMatchObject({ status: 404 });
    expect(await create("other")).toMatchObject({ status: 503 });
    expect(credentials).toBe(2);
  });
});
