import { describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

import {
  validateHop1Jwt,
  type Hop1Identity,
  type IssuerProfile,
} from "../../../shared/identity/hop1";
import {
  createRemoteShellHttpHandler,
  REMOTE_SHELL_GRANT,
  type RemoteShellAuditEvent,
} from "./http";
import {
  type SsmCommandJob,
  type SsmRunCommand,
  type SsmRunRequest,
  type SsmRunResult,
} from "./ssm-run-command";

const claim = ["ste", "ward"].join("");
const binding = {
  issuer: "https://identity.example.com",
  subject: "user-123",
  targets: { controller: "i-0123456789abcdef0" },
};
const success: SsmRunResult = {
  exit_code: 0,
  stdout: "ok\n",
  stderr: "",
  stdout_bytes: 3,
  stderr_bytes: 0,
  stdout_truncated: false,
  stderr_truncated: false,
  duration_ms: 12,
};

describe("remote shell HTTP", () => {
  test("serves only the shell endpoint and preserves the exact grant and bound role", async () => {
    const requests: SsmRunRequest[] = [];
    const events: RemoteShellAuditEvent[] = [];
    const ssm = fakeSsm({
      execute: (request) => {
        requests.push(request);
        return Promise.resolve(success);
      },
    });
    const handler = createRemoteShellHttpHandler(baseOptions(ssm, events));

    expect(await handler(apiRequest("/mcp", { method: "POST", body: {} }))).toMatchObject({
      status: 404,
    });
    const response = await handler(
      apiRequest("/shell/run?wait=full", {
        method: "POST",
        body: { target: "controller", command: "pwd && printf ok", timeout_seconds: 20 },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ exit_code: 0, stdout: "ok\n", stderr: "" });
    expect(requests).toEqual([
      {
        instanceId: "i-0123456789abcdef0",
        command: "pwd && printf ok",
        timeoutSeconds: 20,
      },
    ]);
    expect(events[0]).toMatchObject({ status: "allow", runtime_uid: "runtime-a", exit_code: 0 });
    expect(JSON.stringify(events)).not.toMatch(/pwd|i-0123456789abcdef0|ok\\n/);
  });

  test("returns buffered NDJSON without claiming live SSM output", async () => {
    const handler = createRemoteShellHttpHandler(baseOptions(fakeSsm()));
    const response = await handler(
      apiRequest("/shell/run", {
        method: "POST",
        body: { target: "controller", command: "true" },
      }),
    );

    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    expect(parseNdjson(await response.text())).toEqual([
      { type: "stdout", data: "ok\n" },
      { type: "exit", exit_code: 0, truncated: false },
    ]);
    expect(await handler(apiRequest("/shell/jobs/cmd-1/stream"))).toMatchObject({ status: 404 });
  });

  test("refuses missing authority, runtime identity, targets, and caller-controlled fields", async () => {
    const calls: SsmRunRequest[] = [];
    const handler = createRemoteShellHttpHandler({
      ...baseOptions(
        fakeSsm({
          execute: (request) => {
            calls.push(request);
            return Promise.resolve(success);
          },
        }),
      ),
      authenticate: (token) => {
        if (token === "read") return Promise.resolve(taskIdentity("read"));
        if (token === "no-runtime") return Promise.resolve(taskIdentity("write", null));
        if (token === "unbound") {
          const identity = taskIdentity("write");
          const authority = identity.claims[claim] as Record<string, unknown>;
          delete authority.remote_shell_targets;
          return Promise.resolve(identity);
        }
        return Promise.resolve(taskIdentity("write"));
      },
    });

    const run = { target: "controller", command: "true" };
    const denied: [Request, number][] = [
      [new Request("http://localhost/shell/run", { method: "POST", body: "{}" }), 401],
      ...["read", "no-runtime", "unbound"].map(
        (token) =>
          [apiRequest("/shell/run?wait=full", { method: "POST", token, body: run }), 403] as [
            Request,
            number,
          ],
      ),
      ...["worker", "i-0123456789abcdef0"].map(
        (target) =>
          [
            apiRequest("/shell/run?wait=full", { method: "POST", body: { ...run, target } }),
            403,
          ] as [Request, number],
      ),
      ...[
        { target: "controller", command: "true", document_name: "Custom" },
        { target: "controller", command: "true", instance_id: "i-0123456789abcdef0" },
        { target: "controller", command: "true", run_tag_key: "attacker-controlled" },
        { target: "controller", command: "true", timeout_seconds: 9 },
      ].map(
        (body) =>
          [apiRequest("/shell/run?wait=full", { method: "POST", body }), 400] as [Request, number],
      ),
    ];
    for (const [request, status] of denied) {
      expect((await handler(request)).status).toBe(status);
    }
    expect(calls).toHaveLength(0);
  });

  test("refuses targets absent from the signed run-token claim", async () => {
    const calls: SsmRunRequest[] = [];
    const handler = createRemoteShellHttpHandler({
      ...baseOptions(
        fakeSsm({
          execute: (request) => {
            calls.push(request);
            return Promise.resolve(success);
          },
        }),
      ),
      authenticate: () => Promise.resolve(taskIdentity("write", "runtime-a", binding.targets)),
    });

    const response = await handler(
      apiRequest("/shell/run?wait=full", {
        method: "POST",
        body: { target: "worker", command: "true" },
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "remote_shell_target_not_bound" });
    expect(calls).toHaveLength(0);
  });

  test("refuses a legacy tag-only match when the signed run token has no targets", async () => {
    const calls: SsmRunRequest[] = [];
    const identity = taskIdentity("write");
    const authority = identity.claims[claim] as Record<string, unknown>;
    delete authority.remote_shell_targets;
    const handler = createRemoteShellHttpHandler({
      ...baseOptions(
        fakeSsm({
          execute: (request) => {
            calls.push(request);
            return Promise.resolve(success);
          },
        }),
      ),
      authenticate: () => Promise.resolve(identity),
    });

    const response = await handler(
      apiRequest("/shell/run?wait=full", {
        method: "POST",
        body: { target: "controller", command: "true" },
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "remote_shell_target_not_bound" });
    expect(calls).toHaveLength(0);
  });

  test("refuses tampered and expired signed run tokens before SSM", async () => {
    const profile: IssuerProfile = {
      name: "test",
      issuer: binding.issuer,
      audiences: ["remote-shell-test"],
      allowedAlgorithms: ["EdDSA"],
      emailClaim: "email",
    };
    const pair = await generateKeyPair("EdDSA", { extractable: true });
    const publicJwk = {
      ...(await exportJWK(pair.publicKey)),
      alg: "EdDSA",
      kid: "remote-shell-test",
      use: "sig",
    };
    const claims = {
      iss: profile.issuer,
      aud: profile.audiences[0],
      sub: binding.subject,
      email: "user@example.com",
      [claim]: taskIdentity("write").claims[claim],
    };
    const valid = await new SignJWT(claims)
      .setProtectedHeader({ alg: "EdDSA", kid: "remote-shell-test" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(pair.privateKey);
    const [header = "", payload = "", signature = ""] = valid.split(".");
    const tampered = `${header}.${payload.slice(0, -1)}${payload.endsWith("A") ? "B" : "A"}.${signature}`;
    const expired = await new SignJWT(claims)
      .setProtectedHeader({ alg: "EdDSA", kid: "remote-shell-test" })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) - 1)
      .sign(pair.privateKey);
    const calls: SsmRunRequest[] = [];
    const handler = createRemoteShellHttpHandler({
      ...baseOptions(
        fakeSsm({
          execute: (request) => {
            calls.push(request);
            return Promise.resolve(success);
          },
        }),
      ),
      authenticate: (token) => validateHop1Jwt(token, profile, [publicJwk]),
    });

    for (const token of [tampered, expired]) {
      const response = await handler(
        apiRequest("/shell/run?wait=full", {
          method: "POST",
          token,
          body: { target: "controller", command: "true" },
        }),
      );
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: "unauthorized" });
    }
    expect(calls).toHaveLength(0);
  });

  test("maps execution failures without leaking command data", async () => {
    const events: RemoteShellAuditEvent[] = [];
    const handler = createRemoteShellHttpHandler(
      baseOptions(
        fakeSsm({
          execute: () => Promise.reject(new Error("AWS_SECRET_ACCESS_KEY=server-secret")),
        }),
        events,
      ),
    );
    const response = await handler(
      apiRequest("/shell/run?wait=full", {
        method: "POST",
        body: { target: "controller", command: "printf server-secret" },
      }),
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: "remote_shell_execution_failed" });
    expect(JSON.stringify(events)).not.toContain("server-secret");
    expect(events[0]).toMatchObject({ status: "error", error: "remote_shell_execution_failed" });
  });

  test("uses the SSM command ID for an owned async job", async () => {
    let complete!: (result: SsmRunResult) => void;
    const waits: SsmCommandJob[] = [];
    const ssm = fakeSsm({
      wait: (job) => {
        waits.push(job);
        return new Promise((resolve) => {
          complete = resolve;
        });
      },
    });
    const handler = createRemoteShellHttpHandler(baseOptions(ssm));
    const created = await handler(
      apiRequest("/shell/jobs", {
        method: "POST",
        body: { target: "controller", command: "true" },
      }),
    );

    expect(created.status).toBe(202);
    expect(await created.json()).toEqual({ job_id: "cmd-owned", status: "running" });
    await Bun.sleep(0);
    expect(waits[0]?.commandId).toBe("cmd-owned");
    expect(await (await handler(apiRequest("/shell/jobs/cmd-owned"))).json()).toMatchObject({
      job_id: "cmd-owned",
      status: "running",
    });
    complete(success);
    await Bun.sleep(0);
    expect(await (await handler(apiRequest("/shell/jobs/cmd-owned"))).json()).toMatchObject({
      job_id: "cmd-owned",
      status: "completed",
      result: { exit_code: 0, stdout: "ok\n", stderr: "" },
    });
  });

  test("hides foreign and externally created SSM command IDs before status or cancel", async () => {
    const waits: SsmCommandJob[] = [];
    const cancels: SsmCommandJob[] = [];
    const ssm = fakeSsm({
      wait: (job) => {
        waits.push(job);
        return new Promise(() => undefined);
      },
      cancel: (job) => {
        cancels.push(job);
        return Promise.resolve();
      },
    });
    const handler = createRemoteShellHttpHandler({
      ...baseOptions(ssm),
      authenticate: (token) =>
        Promise.resolve(taskIdentity("write", token === "foreign" ? "runtime-b" : "runtime-a")),
    });
    await handler(
      apiRequest("/shell/jobs", {
        method: "POST",
        body: { target: "controller", command: "true" },
      }),
    );
    await Bun.sleep(0);

    for (const [commandId, token] of [
      ["cmd-owned", "foreign"],
      ["cmd-created-outside-this-server", undefined],
    ] as const) {
      expect(await handler(apiRequest(`/shell/jobs/${commandId}`, { token }))).toMatchObject({
        status: 404,
      });
      expect(
        await handler(apiRequest(`/shell/jobs/${commandId}/cancel`, { method: "POST", token })),
      ).toMatchObject({ status: 404 });
    }
    expect(waits).toHaveLength(1);
    expect(cancels).toHaveLength(0);

    const cancelled = await handler(apiRequest("/shell/jobs/cmd-owned/cancel", { method: "POST" }));
    expect(cancelled.status).toBe(202);
    expect(cancels.map((job) => job.commandId)).toEqual(["cmd-owned"]);
  });

  test("enforces configured request and per-owner job limits", async () => {
    let nextId = 0;
    const calls: SsmRunRequest[] = [];
    const ssm = fakeSsm({
      start: (request) => {
        calls.push(request);
        return Promise.resolve({
          commandId: `cmd-${String(++nextId)}`,
          instanceId: request.instanceId,
          startedAt: 0,
          deadline: 60_000,
        });
      },
      wait: () => new Promise(() => undefined),
    });
    const handler = createRemoteShellHttpHandler({
      ...baseOptions(ssm),
      requestLimits: { maxBodyBytes: 100, maxCommandBytes: 4 },
      jobLimits: { maxJobs: 2, maxRunningJobsPerOwner: 1, retentionSeconds: 1 },
    });

    expect(
      await handler(
        apiRequest("/shell/run?wait=full", {
          method: "POST",
          body: { target: "controller", command: "12345" },
        }),
      ),
    ).toMatchObject({ status: 400 });
    expect(
      await handler(
        new Request("http://localhost/shell/run", {
          method: "POST",
          headers: { authorization: "Bearer run-token", "content-length": "101" },
          body: "{}",
        }),
      ),
    ).toMatchObject({ status: 413 });
    const create = () =>
      handler(
        apiRequest("/shell/jobs", {
          method: "POST",
          body: { target: "controller", command: "true" },
        }),
      );
    expect(await create()).toMatchObject({ status: 202 });
    expect(await create()).toMatchObject({ status: 503 });
    expect(calls).toHaveLength(1);
  });
});

function baseOptions(ssm: SsmRunCommand, events: RemoteShellAuditEvent[] = []) {
  return {
    authenticate: () => Promise.resolve(taskIdentity("write")),
    maxTimeoutSeconds: 60,
    requestLimits: { maxBodyBytes: 17 * 1024, maxCommandBytes: 16 * 1024 },
    jobLimits: { maxJobs: 64, maxRunningJobsPerOwner: 4, retentionSeconds: 30 * 60 },
    ssm,
    audit: {
      emit: (event: RemoteShellAuditEvent) =>
        Promise.resolve(events.push(event)).then(() => undefined),
    },
  };
}

function taskIdentity(
  action: string,
  runtimeUid: string | null = "runtime-a",
  targets: Record<string, string> = binding.targets,
): Hop1Identity {
  return {
    profile: "test",
    issuer: binding.issuer,
    subject: binding.subject,
    email: "user@example.com",
    claims: {
      [claim]: {
        version: 3,
        acting_as: "user",
        ...(runtimeUid ? { runtime_uid: runtimeUid } : {}),
        remote_shell_targets: targets,
        tools: [{ ...REMOTE_SHELL_GRANT, action }],
      },
    },
  };
}

function fakeSsm(
  overrides: {
    execute?: (request: SsmRunRequest) => Promise<SsmRunResult>;
    start?: (request: SsmRunRequest) => Promise<SsmCommandJob>;
    wait?: (job: SsmCommandJob) => Promise<SsmRunResult>;
    cancel?: (job: SsmCommandJob) => Promise<void>;
  } = {},
): SsmRunCommand {
  const execute = overrides.execute ?? (() => Promise.resolve(success));
  return Object.assign(execute, {
    start:
      overrides.start ??
      ((request: SsmRunRequest) =>
        Promise.resolve({
          commandId: "cmd-owned",
          instanceId: request.instanceId,
          startedAt: 0,
          deadline: request.timeoutSeconds * 1000 + 15_000,
        })),
    wait: overrides.wait ?? (() => Promise.resolve(success)),
    cancel: overrides.cancel ?? (() => Promise.resolve()),
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

function parseNdjson(value: string): unknown[] {
  return value
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
}
