import { createHash, randomUUID } from "node:crypto";

import type { GenericUpstreamCredential } from "./credentials";
import type { GenericServerInfo, GenericUpstreamDescriptor } from "./descriptor";

export interface GenericUpstreamRequest {
  incomingRequest: Request;
  body: string;
  credential: GenericUpstreamCredential | null;
  principalKey: string;
}

export interface GenericUpstreamTransport {
  send(request: GenericUpstreamRequest): Promise<Response>;
  close?(request: GenericUpstreamRequest): Promise<Response | void>;
}

export interface CreateHttpUpstreamTransportOptions {
  fetch?: GenericTransportFetch;
  serverInfo?: GenericServerInfo;
  maxSessions?: number;
  sessionIdleTtlMs?: number;
  now?: () => number;
}

export interface CreateStdioUpstreamTransportOptions {
  maxSessions?: number;
  sessionIdleTtlMs?: number;
  now?: () => number;
}

export type GenericTransportFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const FORWARDED_HEADERS = ["accept", "content-type", "mcp-protocol-version", "mcp-session-id"];

interface HttpSession {
  principalKey: string;
  upstreamSessionId?: string;
  initialized: boolean;
  tail: Promise<void>;
  credential: GenericUpstreamCredential | null;
  lastUsedAt: number;
}

const DEFAULT_HTTP_MAX_SESSIONS = 1_024;
const DEFAULT_STDIO_MAX_SESSIONS = 64;
const DEFAULT_SESSION_IDLE_TTL_MS = 30 * 60 * 1_000;

export function createHttpUpstreamTransport(
  descriptor: Extract<GenericUpstreamDescriptor, { transport: "http" }>,
  options: CreateHttpUpstreamTransportOptions = {},
): GenericUpstreamTransport {
  const fetchImpl = options.fetch ?? fetch;
  const sessions = new Map<string, HttpSession>();
  const maxSessions = positiveLimit(options.maxSessions, DEFAULT_HTTP_MAX_SESSIONS, "maxSessions");
  const idleTtlMs = positiveLimit(
    options.sessionIdleTtlMs,
    DEFAULT_SESSION_IDLE_TTL_MS,
    "sessionIdleTtlMs",
  );
  const now = options.now ?? Date.now;
  const serverInfo = options.serverInfo ?? {
    name: "mcp-gateway-generic-wrapper",
    version: "1.0.0",
  };
  return {
    async send(request) {
      const localSessionId = request.incomingRequest.headers.get("mcp-session-id") ?? undefined;
      if (!localSessionId) return sendHttpRequest(descriptor, fetchImpl, request);
      let session = sessions.get(localSessionId);
      if (!session) {
        pruneIdleHttpSessions(sessions, now(), idleTtlMs);
        if (sessions.size >= maxSessions) {
          throw new Error("HTTP MCP upstream session limit reached");
        }
        session = {
          principalKey: request.principalKey,
          initialized: false,
          tail: Promise.resolve(),
          credential: request.credential,
          lastUsedAt: now(),
        };
        sessions.set(localSessionId, session);
      }
      assertSessionPrincipal(session, request.principalKey);
      session.credential = request.credential;
      session.lastUsedAt = now();
      return withHttpSessionLock(session, async () => {
        const initializing = parseMessage(request.body)?.method === "initialize";
        if (!session.initialized && !initializing) {
          await initializeHttpSession(descriptor, fetchImpl, request, session, serverInfo);
        }
        const response = await sendHttpRequest(
          descriptor,
          fetchImpl,
          request,
          session.upstreamSessionId,
        );
        const mapped = mapHttpSessionResponse(response, localSessionId, session);
        if (initializing && response.ok) session.initialized = true;
        return mapped;
      });
    },
    async close(request) {
      const localSessionId = request.incomingRequest.headers.get("mcp-session-id") ?? undefined;
      if (!localSessionId) return;
      const session = sessions.get(localSessionId);
      if (!session) return;
      assertSessionPrincipal(session, request.principalKey);
      sessions.delete(localSessionId);
      if (!session.initialized) return;
      return withHttpSessionLock(session, async () => {
        const response = await sendHttpRequest(
          descriptor,
          fetchImpl,
          {
            ...request,
            credential: request.credential ?? session.credential,
          },
          session.upstreamSessionId,
        );
        return mapHttpSessionResponse(response, localSessionId, session);
      });
    },
  };
}

async function initializeHttpSession(
  descriptor: Extract<GenericUpstreamDescriptor, { transport: "http" }>,
  fetchImpl: GenericTransportFetch,
  request: GenericUpstreamRequest,
  session: HttpSession,
  serverInfo: GenericServerInfo,
): Promise<void> {
  const protocolVersion =
    request.incomingRequest.headers.get("mcp-protocol-version") ?? "2025-06-18";
  const initialize = await sendHttpRequest(descriptor, fetchImpl, {
    ...request,
    incomingRequest: requestWithMethod(request.incomingRequest, "POST", false),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `generic-wrapper-${randomUUID()}`,
      method: "initialize",
      params: { protocolVersion, capabilities: {}, clientInfo: serverInfo },
    }),
  });
  if (!initialize.ok) throw new Error("MCP upstream initialization failed");
  await initialize.arrayBuffer();
  session.upstreamSessionId = initialize.headers.get("mcp-session-id") ?? undefined;
  const initialized = await sendHttpRequest(
    descriptor,
    fetchImpl,
    {
      ...request,
      incomingRequest: requestWithMethod(request.incomingRequest, "POST", false),
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      }),
    },
    session.upstreamSessionId,
  );
  if (!initialized.ok) throw new Error("MCP upstream initialization notification failed");
  await initialized.arrayBuffer();
  session.initialized = true;
}

function sendHttpRequest(
  descriptor: Extract<GenericUpstreamDescriptor, { transport: "http" }>,
  fetchImpl: GenericTransportFetch,
  request: GenericUpstreamRequest,
  upstreamSessionId?: string,
): Promise<Response> {
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    if (name === "mcp-session-id") continue;
    const value = request.incomingRequest.headers.get(name);
    if (value) headers.set(name, value);
  }
  const lastEventId = request.incomingRequest.headers.get("last-event-id");
  if (lastEventId) headers.set("last-event-id", lastEventId);
  if (upstreamSessionId) headers.set("mcp-session-id", upstreamSessionId);
  if (request.credential) headers.set(request.credential.header, request.credential.value);
  const method = request.incomingRequest.method;
  return fetchImpl(descriptor.url, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : request.body,
    signal: AbortSignal.timeout(descriptor.timeoutMs ?? 30_000),
  });
}

function mapHttpSessionResponse(
  response: Response,
  localSessionId: string,
  session: HttpSession,
): Response {
  const newUpstreamSessionId = response.headers.get("mcp-session-id");
  if (newUpstreamSessionId) session.upstreamSessionId = newUpstreamSessionId;
  const headers = new Headers(response.headers);
  headers.set("mcp-session-id", localSessionId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function requestWithMethod(request: Request, method: string, includeSession: boolean): Request {
  const headers = new Headers(request.headers);
  if (!includeSession) headers.delete("mcp-session-id");
  return new Request(request.url, { method, headers });
}

function assertSessionPrincipal(session: { principalKey: string }, principalKey: string): void {
  if (session.principalKey !== principalKey) {
    throw new Error("MCP session does not belong to this principal");
  }
}

async function withHttpSessionLock<T>(
  session: HttpSession,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = session.tail;
  let release: () => void = () => {};
  session.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

interface StdioSession {
  id: string;
  principalKey: string;
  credentialDigest: string;
  child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  reader: {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
  };
  buffer: string;
  tail: Promise<void>;
  lastUsedAt: number;
}

export function createStdioUpstreamTransport(
  descriptor: Extract<GenericUpstreamDescriptor, { transport: "stdio" }>,
  env: Record<string, string | undefined> = process.env,
  serverInfo: GenericServerInfo = {
    name: "mcp-gateway-generic-wrapper",
    version: "1.0.0",
  },
  options: CreateStdioUpstreamTransportOptions = {},
): GenericUpstreamTransport {
  const sessions = new Map<string, StdioSession>();
  const timeoutMs = descriptor.timeoutMs ?? 30_000;
  const maxSessions = positiveLimit(options.maxSessions, DEFAULT_STDIO_MAX_SESSIONS, "maxSessions");
  const idleTtlMs = positiveLimit(
    options.sessionIdleTtlMs,
    DEFAULT_SESSION_IDLE_TTL_MS,
    "sessionIdleTtlMs",
  );
  const now = options.now ?? Date.now;

  return {
    async send(request) {
      const message = parseMessage(request.body);
      const requestedSession = request.incomingRequest.headers.get("mcp-session-id") ?? undefined;
      let session: StdioSession;
      let needsInitialization = false;
      const sessionId = requestedSession ?? randomUUID();
      const existing = sessions.get(sessionId);
      if (!existing) {
        pruneIdleStdioSessions(sessions, now(), idleTtlMs);
        if (sessions.size >= maxSessions) {
          throw new Error("stdio MCP upstream session limit reached");
        }
        session = spawnSession(descriptor, request, env, sessionId, now());
        sessions.set(session.id, session);
        void session.child.exited.finally(() => {
          if (sessions.get(session.id) === session) sessions.delete(session.id);
        });
        if (message?.method !== "initialize") {
          needsInitialization = true;
        }
      } else {
        if (existing.principalKey !== request.principalKey) {
          throw new Error("stdio MCP session does not belong to this principal");
        }
        if (existing.credentialDigest !== credentialDigest(request.credential)) {
          throw new Error("stdio MCP credential changed; initialize a new session");
        }
        session = existing;
      }
      session.lastUsedAt = now();

      return withSessionLock(session, async () => {
        if (needsInitialization) {
          await initializeStdioSession(session, request, serverInfo, timeoutMs);
        }
        session.child.stdin.write(`${request.body}\n`);
        await session.child.stdin.flush();
        if (!message?.hasId) {
          return new Response(null, {
            status: 202,
            headers: { "mcp-session-id": session.id },
          });
        }
        const line = await withTimeout(readLine(session), timeoutMs);
        return new Response(line, {
          status: 200,
          headers: {
            "content-type": "application/json",
            "mcp-session-id": session.id,
          },
        });
      });
    },
    async close(request) {
      const sessionId = request.incomingRequest.headers.get("mcp-session-id") ?? undefined;
      if (!sessionId) return;
      const session = sessions.get(sessionId);
      if (!session) return;
      if (session.principalKey !== request.principalKey) {
        throw new Error("stdio MCP session does not belong to this principal");
      }
      sessions.delete(sessionId);
      session.child.kill();
      await withTimeout(
        session.child.exited.then(() => undefined),
        timeoutMs,
      ).catch(() => undefined);
    },
  };
}

function spawnSession(
  descriptor: Extract<GenericUpstreamDescriptor, { transport: "stdio" }>,
  request: GenericUpstreamRequest,
  sourceEnv: Record<string, string | undefined>,
  sessionId: string,
  lastUsedAt: number,
): StdioSession {
  const childEnv: Record<string, string> = {};
  for (const name of descriptor.envAllowlist ?? []) {
    const value = sourceEnv[name];
    if (value !== undefined) childEnv[name] = value;
  }
  if (descriptor.credentialEnv && request.credential?.rawValue) {
    childEnv[descriptor.credentialEnv] = request.credential.rawValue;
  }
  const child = Bun.spawn([descriptor.command, ...descriptor.args], {
    cwd: process.cwd(),
    env: childEnv,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  void new Response(child.stderr).text();
  return {
    id: sessionId,
    principalKey: request.principalKey,
    credentialDigest: credentialDigest(request.credential),
    child,
    reader: child.stdout.getReader(),
    buffer: "",
    tail: Promise.resolve(),
    lastUsedAt,
  };
}

function pruneIdleHttpSessions(
  sessions: Map<string, HttpSession>,
  now: number,
  idleTtlMs: number,
): void {
  for (const [sessionId, session] of sessions) {
    if (now - session.lastUsedAt >= idleTtlMs) sessions.delete(sessionId);
  }
}

function pruneIdleStdioSessions(
  sessions: Map<string, StdioSession>,
  now: number,
  idleTtlMs: number,
): void {
  for (const [sessionId, session] of sessions) {
    if (now - session.lastUsedAt < idleTtlMs) continue;
    sessions.delete(sessionId);
    session.child.kill();
  }
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1)
    throw new Error(`${name} must be a positive integer`);
  return result;
}

async function initializeStdioSession(
  session: StdioSession,
  request: GenericUpstreamRequest,
  serverInfo: GenericServerInfo,
  timeoutMs: number,
): Promise<void> {
  const protocolVersion =
    request.incomingRequest.headers.get("mcp-protocol-version") ?? "2025-06-18";
  session.child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: `generic-wrapper-${randomUUID()}`,
      method: "initialize",
      params: { protocolVersion, capabilities: {}, clientInfo: serverInfo },
    })}\n`,
  );
  await session.child.stdin.flush();
  await withTimeout(readLine(session), timeoutMs);
  session.child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    })}\n`,
  );
  await session.child.stdin.flush();
}

async function withSessionLock<T>(session: StdioSession, operation: () => Promise<T>): Promise<T> {
  const previous = session.tail;
  let release: () => void = () => {};
  session.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

async function readLine(session: StdioSession): Promise<string> {
  while (true) {
    const newline = session.buffer.indexOf("\n");
    if (newline >= 0) {
      const line = session.buffer.slice(0, newline).trim();
      session.buffer = session.buffer.slice(newline + 1);
      if (line) return line;
      continue;
    }
    const next = await session.reader.read();
    if (next.done || !next.value) throw new Error("stdio MCP upstream exited before responding");
    session.buffer += new TextDecoder().decode(next.value, { stream: true });
  }
}

function parseMessage(body: string): { method?: string; hasId: boolean } | undefined {
  try {
    const value = JSON.parse(body) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    return {
      ...(typeof record.method === "string" ? { method: record.method } : {}),
      hasId: Object.prototype.hasOwnProperty.call(record, "id"),
    };
  } catch {
    return undefined;
  }
}

function credentialDigest(credential: GenericUpstreamCredential | null): string {
  return createHash("sha256")
    .update(credential?.rawValue ?? credential?.value ?? "")
    .digest("hex");
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("stdio MCP upstream timed out")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
