export type BackendConformanceScenario =
  "normal" | "policy_denied" | "upstream_5xx" | "upstream_timeout";

export interface BackendConformanceToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface BackendConformanceScenarioControl {
  activate: () => void | Promise<void>;
  toolCall?: BackendConformanceToolCall;
}

export interface BackendConformanceTarget {
  name: string;
  endpoint: string;
  send(request: Request): Promise<Response>;
  tokens: {
    valid: string;
    expired: string;
    wrongAudience: string;
    otherPrincipal?: string;
  };
  sessionMode: "required" | "optional";
  policyDenial: "mcp_tool_error" | "jsonrpc_error" | "transport_error";
  toolCall: BackendConformanceToolCall;
  concurrency?: number;
  requestTimeoutMs?: number;
  scenarios?: {
    policyDenied?: BackendConformanceScenarioControl;
    upstream5xx?: BackendConformanceScenarioControl;
    upstreamTimeout?: BackendConformanceScenarioControl;
    gatewayFailOpen?: BackendConformanceScenarioControl;
    gatewayFailClosed?: BackendConformanceScenarioControl;
    reset?: () => void | Promise<void>;
  };
  evidence?: {
    upstream: () => readonly string[] | Promise<readonly string[]>;
    logs: () => string | Promise<string>;
    forbiddenUpstreamValues: readonly string[];
    requiredUpstreamValues?: readonly string[];
    forbiddenOutputValues: readonly string[];
  };
}

export interface BackendConformanceFailure {
  check: string;
  message: string;
}

export interface BackendConformanceSkip {
  check: string;
  reason: string;
}

export interface BackendConformanceReport {
  target: string;
  passed: string[];
  skipped: BackendConformanceSkip[];
  failures: BackendConformanceFailure[];
}

interface RpcObservation {
  status?: number;
  headers?: Headers;
  bodyText?: string;
  body?: unknown;
  transportError?: true;
}

interface RunState {
  sessionId?: string;
  outputs: string[];
}

const PROTOCOL_VERSION = "2025-06-18";
const MAX_OBSERVED_BODY_BYTES = 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Runs the backend-facing MCP-GW contract against any request function. Use
 * `send: fetch` for a real URL, or bind an in-process handler for deterministic
 * wrapper CI. Optional controlled scenarios add policy and failure checks.
 */
export async function runBackendConformance(
  target: BackendConformanceTarget,
): Promise<BackendConformanceReport> {
  const report: BackendConformanceReport = {
    target: target.name,
    passed: [],
    skipped: [],
    failures: [],
  };
  const state: RunState = { outputs: [] };

  await check(report, "authentication.missing", async () => {
    const observed = await rpc(target, state, undefined, initializeMessage("auth-missing"));
    requireUnauthorized(observed, "Bearer");
  });
  await check(report, "authentication.expired", async () => {
    const observed = await rpc(
      target,
      state,
      target.tokens.expired,
      initializeMessage("auth-expired"),
    );
    requireUnauthorized(observed, 'Bearer error="invalid_token"');
  });
  await check(report, "authentication.wrong_audience", async () => {
    const observed = await rpc(
      target,
      state,
      target.tokens.wrongAudience,
      initializeMessage("auth-audience"),
    );
    requireUnauthorized(observed, 'Bearer error="invalid_token"');
  });
  await check(report, "protocol.initialize", async () => {
    const observed = await rpc(target, state, target.tokens.valid, initializeMessage("initialize"));
    requireStatus(observed, 200);
    const result = rpcResult(observed);
    if (!isRecord(result) || result.protocolVersion !== PROTOCOL_VERSION) {
      throw new ConformanceFailure("initialize did not negotiate the required protocol version");
    }
    const issuedSession = observed.headers?.get("mcp-session-id")?.trim();
    if (target.sessionMode === "required" && !issuedSession) {
      throw new ConformanceFailure("initialize did not issue an MCP session ID");
    }
    state.sessionId = issuedSession === "" ? undefined : issuedSession;
  });

  if (target.sessionMode === "required") {
    await check(report, "sessions.reject_unissued", async () => {
      const observed = await rpc(
        target,
        state,
        target.tokens.valid,
        message("tools/list", {}, "unissued-session"),
        "caller-invented-session",
      );
      requireErrorOutcome(observed, "an unissued session was accepted");
    });
    if (target.tokens.otherPrincipal) {
      await check(report, "sessions.principal_isolation", async () => {
        const observed = await rpc(
          target,
          state,
          target.tokens.otherPrincipal,
          message("tools/list", {}, "cross-principal-session"),
        );
        requireErrorOutcome(observed, "a session was accepted for a different principal");
      });
    } else {
      skip(report, "sessions.principal_isolation", "no alternate-principal token configured");
    }
  } else {
    skip(report, "sessions.reject_unissued", "target does not require stateful sessions");
    skip(report, "sessions.principal_isolation", "target does not require stateful sessions");
  }

  await check(report, "protocol.initialized_notification", async () => {
    const observed = await rpc(
      target,
      state,
      target.tokens.valid,
      message("notifications/initialized", {}),
    );
    requireStatus(observed, 202);
  });
  await check(report, "protocol.tools_list", async () => {
    const observed = await rpc(
      target,
      state,
      target.tokens.valid,
      message("tools/list", {}, "tools-list"),
    );
    requireStatus(observed, 200);
    const result = rpcResult(observed);
    const tools = isRecord(result) && Array.isArray(result.tools) ? result.tools : undefined;
    if (
      !tools?.some(
        (tool) =>
          isRecord(tool) && typeof tool.name === "string" && tool.name === target.toolCall.name,
      )
    ) {
      throw new ConformanceFailure("tools/list omitted the configured conformance tool");
    }
  });
  await check(report, "protocol.tools_call", async () => {
    const observed = await toolCall(target, state, target.toolCall, "tools-call");
    requireStatus(observed, 200);
    requireSuccessOutcome(observed);
  });
  await check(report, "concurrency.parallel_reads", async () => {
    const count = target.concurrency ?? 4;
    const observations = await Promise.all(
      Array.from({ length: count }, (_, index) =>
        rpc(
          target,
          state,
          target.tokens.valid,
          message("tools/list", {}, `parallel-${String(index)}`),
        ),
      ),
    );
    for (const observed of observations) {
      requireStatus(observed, 200);
      rpcResult(observed);
    }
  });

  await scenarioCheck(
    report,
    "policy.denied_grant",
    target.scenarios?.policyDenied,
    target.scenarios?.reset,
    async (scenario) => {
      const observed = await toolCall(
        target,
        state,
        scenario.toolCall ?? target.toolCall,
        "policy-denied",
      );
      requirePolicyDenied(observed, target.policyDenial);
    },
  );
  await scenarioCheck(
    report,
    "failure.upstream_5xx",
    target.scenarios?.upstream5xx,
    target.scenarios?.reset,
    async (scenario) => {
      const observed = await toolCall(
        target,
        state,
        scenario.toolCall ?? target.toolCall,
        "upstream-5xx",
      );
      requireErrorOutcome(observed, "an upstream 5xx was reported as success");
    },
  );
  await scenarioCheck(
    report,
    "failure.upstream_timeout",
    target.scenarios?.upstreamTimeout,
    target.scenarios?.reset,
    async (scenario) => {
      const observed = await toolCall(
        target,
        state,
        scenario.toolCall ?? target.toolCall,
        "upstream-timeout",
      );
      requireErrorOutcome(observed, "an upstream timeout was reported as success");
    },
  );
  await scenarioCheck(
    report,
    "routing.fail_open",
    target.scenarios?.gatewayFailOpen,
    target.scenarios?.reset,
    async (scenario) => {
      const observed = await toolCall(
        target,
        state,
        scenario.toolCall ?? target.toolCall,
        "gateway-fail-open",
      );
      requireStatus(observed, 200);
      requireSuccessOutcome(observed);
    },
  );
  await scenarioCheck(
    report,
    "routing.fail_closed",
    target.scenarios?.gatewayFailClosed,
    target.scenarios?.reset,
    async (scenario) => {
      const observed = await toolCall(
        target,
        state,
        scenario.toolCall ?? target.toolCall,
        "gateway-fail-closed",
      );
      requireErrorOutcome(observed, "failClosed accepted a partial backend failure");
    },
  );

  if (target.evidence) {
    await check(report, "security.hop1_not_forwarded", async () => {
      const upstream = (await target.evidence?.upstream())?.join("\n") ?? "";
      for (const forbidden of target.evidence?.forbiddenUpstreamValues ?? []) {
        if (forbidden && upstream.includes(forbidden)) {
          throw new ConformanceFailure("HOP-1 credential appeared in upstream evidence");
        }
      }
      for (const required of target.evidence?.requiredUpstreamValues ?? []) {
        if (!required || !upstream.includes(required)) {
          throw new ConformanceFailure("expected HOP-2 credential was absent upstream");
        }
      }
    });
    await check(report, "security.secret_safe_outputs", async () => {
      const logs = await target.evidence?.logs();
      const observed = [...state.outputs, logs ?? ""].join("\n");
      for (const forbidden of target.evidence?.forbiddenOutputValues ?? []) {
        if (forbidden && observed.includes(forbidden)) {
          throw new ConformanceFailure("a credential appeared in a response or diagnostic log");
        }
      }
    });
  } else {
    skip(report, "security.hop1_not_forwarded", "no upstream evidence reader configured");
    skip(report, "security.secret_safe_outputs", "no output evidence reader configured");
  }

  if (target.sessionMode === "required" && state.sessionId) {
    await check(report, "protocol.session_close", async () => {
      const observed = await rawRequest(target, state, target.tokens.valid, {
        method: "DELETE",
        sessionId: state.sessionId,
      });
      if (
        observed.transportError ||
        observed.status === undefined ||
        ![200, 202, 204].includes(observed.status)
      ) {
        throw new ConformanceFailure("DELETE did not close the issued MCP session");
      }
    });
  } else {
    skip(report, "protocol.session_close", "target did not issue a stateful session");
  }

  return report;
}

function requirePolicyDenied(
  observed: RpcObservation,
  expected: BackendConformanceTarget["policyDenial"],
): void {
  if (expected === "transport_error") {
    if (!observed.transportError) {
      throw new ConformanceFailure("policy denial did not stop request execution");
    }
    return;
  }
  requireStatus(observed, 200);
  if (expected === "jsonrpc_error") {
    requireJsonContentType(observed);
    requireJsonRpcEnvelope(observed);
    const error = rpcError(observed);
    if (!isRecord(error) || error.code !== -32003) {
      throw new ConformanceFailure("policy denial omitted the stable JSON-RPC denial error");
    }
    return;
  }
  const result = rpcResult(observed);
  if (
    !isRecord(result) ||
    result.isError !== true ||
    !isRecord(result.structuredContent) ||
    result.structuredContent.error !== "policy_denied"
  ) {
    throw new ConformanceFailure("policy denial omitted the stable MCP tool error");
  }
}

async function scenarioCheck(
  report: BackendConformanceReport,
  name: string,
  scenario: BackendConformanceScenarioControl | undefined,
  reset: (() => void | Promise<void>) | undefined,
  assertion: (scenario: BackendConformanceScenarioControl) => Promise<void>,
): Promise<void> {
  if (!scenario) {
    skip(report, name, "scenario control is not configured");
    return;
  }
  await check(report, name, async () => {
    await scenario.activate();
    try {
      await assertion(scenario);
    } finally {
      await reset?.();
    }
  });
}

async function toolCall(
  target: BackendConformanceTarget,
  state: RunState,
  call: BackendConformanceToolCall,
  id: string,
): Promise<RpcObservation> {
  return rpc(
    target,
    state,
    target.tokens.valid,
    message("tools/call", { name: call.name, arguments: call.arguments }, id),
  );
}

async function rpc(
  target: BackendConformanceTarget,
  state: RunState,
  token: string | undefined,
  payload: Record<string, unknown>,
  sessionId = state.sessionId,
): Promise<RpcObservation> {
  return rawRequest(target, state, token, {
    method: "POST",
    body: JSON.stringify(payload),
    sessionId,
  });
}

async function rawRequest(
  target: BackendConformanceTarget,
  state: RunState,
  token: string | undefined,
  input: { method: string; body?: string; sessionId?: string },
): Promise<RpcObservation> {
  const headers = new Headers({
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": PROTOCOL_VERSION,
  });
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (input.sessionId) headers.set("mcp-session-id", input.sessionId);
  let response: Response;
  try {
    response = await within(
      target.send(
        new Request(target.endpoint, {
          method: input.method,
          headers,
          body: input.body,
        }),
      ),
      target.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );
  } catch {
    return { transportError: true };
  }
  const bodyText = await readBoundedText(response);
  state.outputs.push(bodyText);
  let body: unknown;
  if (bodyText) {
    try {
      body = JSON.parse(bodyText) as unknown;
    } catch {
      body = undefined;
    }
  }
  return { status: response.status, headers: response.headers, bodyText, body };
}

async function readBoundedText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    let result = await reader.read();
    while (!result.done) {
      const { value } = result;
      total += value.byteLength;
      if (total > MAX_OBSERVED_BODY_BYTES) {
        await reader.cancel();
        throw new ConformanceFailure("response body exceeded the conformance observation limit");
      }
      chunks.push(value);
      result = await reader.read();
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function requireUnauthorized(observed: RpcObservation, challenge: string): void {
  requireStatus(observed, 401);
  requireJsonContentType(observed);
  requireJsonRpcEnvelope(observed);
  if (observed.headers?.get("www-authenticate") !== challenge) {
    throw new ConformanceFailure("unauthorized response used the wrong authentication challenge");
  }
  const error = rpcError(observed);
  if (!isRecord(error) || error.code !== -32001) {
    throw new ConformanceFailure("unauthorized response omitted the stable JSON-RPC error");
  }
}

function requireStatus(observed: RpcObservation, expected: number): void {
  if (observed.transportError) {
    throw new ConformanceFailure("request failed before receiving an HTTP response");
  }
  if (observed.status !== expected) {
    throw new ConformanceFailure(
      `expected HTTP ${String(expected)}, received ${String(observed.status ?? "none")}`,
    );
  }
}

function requireSuccessOutcome(observed: RpcObservation): void {
  if (rpcError(observed) !== undefined) {
    throw new ConformanceFailure("tools/call returned a JSON-RPC error");
  }
  const result = rpcResult(observed);
  if (isRecord(result) && result.isError === true) {
    throw new ConformanceFailure("tools/call returned an MCP tool error");
  }
}

function requireErrorOutcome(observed: RpcObservation, successMessage: string): void {
  if (observed.transportError) return;
  if (observed.status !== undefined && observed.status >= 400) return;
  if (rpcError(observed) !== undefined) return;
  const result = rpcResultOrUndefined(observed);
  if (isRecord(result) && result.isError === true) return;
  throw new ConformanceFailure(successMessage);
}

function rpcResult(observed: RpcObservation): unknown {
  requireJsonContentType(observed);
  requireJsonRpcEnvelope(observed);
  const result = rpcResultOrUndefined(observed);
  if (result === undefined) {
    throw new ConformanceFailure("response omitted a JSON-RPC result");
  }
  return result;
}

function rpcResultOrUndefined(observed: RpcObservation): unknown {
  return isRecord(observed.body) ? observed.body.result : undefined;
}

function rpcError(observed: RpcObservation): unknown {
  return isRecord(observed.body) ? observed.body.error : undefined;
}

function requireJsonContentType(observed: RpcObservation): void {
  const contentType = observed.headers?.get("content-type")?.toLowerCase();
  if (!contentType?.startsWith("application/json")) {
    throw new ConformanceFailure("JSON-RPC response omitted the application/json content type");
  }
}

function requireJsonRpcEnvelope(observed: RpcObservation): void {
  if (!isRecord(observed.body) || observed.body.jsonrpc !== "2.0") {
    throw new ConformanceFailure("response omitted the JSON-RPC 2.0 envelope");
  }
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("conformance request timed out")), timeoutMs);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function initializeMessage(id: string): Record<string, unknown> {
  return message(
    "initialize",
    {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "mcp-gw-backend-conformance", version: "1.0.0" },
    },
    id,
  );
}

function message(
  method: string,
  params: Record<string, unknown>,
  id?: string,
): Record<string, unknown> {
  return { jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params };
}

async function check(
  report: BackendConformanceReport,
  name: string,
  assertion: () => Promise<void>,
): Promise<void> {
  try {
    await assertion();
    report.passed.push(name);
  } catch (error) {
    report.failures.push({
      check: name,
      message:
        error instanceof ConformanceFailure
          ? error.message
          : `unexpected ${error instanceof Error ? error.name : "failure"}`,
    });
  }
}

function skip(report: BackendConformanceReport, checkName: string, reason: string): void {
  report.skipped.push({ check: checkName, reason });
}

class ConformanceFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConformanceFailure";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
