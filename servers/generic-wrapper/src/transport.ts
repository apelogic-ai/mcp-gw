import { createHash, randomUUID } from "node:crypto";

import type { GenericUpstreamCredential } from "./credentials";
import type { GenericUpstreamDescriptor } from "./descriptor";

export interface GenericUpstreamRequest {
  incomingRequest: Request;
  body: string;
  credential: GenericUpstreamCredential | null;
  principalKey: string;
}

export interface GenericUpstreamTransport {
  send(request: GenericUpstreamRequest): Promise<Response>;
  close?(sessionId: string | undefined, principalKey: string): Promise<void>;
}

export interface CreateHttpUpstreamTransportOptions {
  fetch?: GenericTransportFetch;
}

export type GenericTransportFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const FORWARDED_HEADERS = ["accept", "content-type", "mcp-protocol-version", "mcp-session-id"];

export function createHttpUpstreamTransport(
  descriptor: Extract<GenericUpstreamDescriptor, { transport: "http" }>,
  options: CreateHttpUpstreamTransportOptions = {},
): GenericUpstreamTransport {
  const fetchImpl = options.fetch ?? fetch;
  return {
    async send(request) {
      const headers = new Headers();
      for (const name of FORWARDED_HEADERS) {
        const value = request.incomingRequest.headers.get(name);
        if (value) headers.set(name, value);
      }
      if (request.credential) {
        headers.set(request.credential.header, request.credential.value);
      }
      return fetchImpl(descriptor.url, {
        method: request.incomingRequest.method,
        headers,
        body: request.incomingRequest.method === "GET" ? undefined : request.body,
        signal: AbortSignal.timeout(descriptor.timeoutMs ?? 30_000),
      });
    },
  };
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
}

export function createStdioUpstreamTransport(
  descriptor: Extract<GenericUpstreamDescriptor, { transport: "stdio" }>,
  env: Record<string, string | undefined> = process.env,
): GenericUpstreamTransport {
  const sessions = new Map<string, StdioSession>();
  const timeoutMs = descriptor.timeoutMs ?? 30_000;

  return {
    async send(request) {
      const message = parseMessage(request.body);
      const requestedSession = request.incomingRequest.headers.get("mcp-session-id") ?? undefined;
      let session: StdioSession;
      if (!requestedSession) {
        if (message?.method !== "initialize") {
          throw new Error("stdio MCP session must be initialized first");
        }
        session = spawnSession(descriptor, request, env);
        sessions.set(session.id, session);
        void session.child.exited.finally(() => {
          if (sessions.get(session.id) === session) sessions.delete(session.id);
        });
      } else {
        const existing = sessions.get(requestedSession);
        if (!existing) throw new Error("stdio MCP session is unknown");
        if (existing.principalKey !== request.principalKey) {
          throw new Error("stdio MCP session does not belong to this principal");
        }
        if (existing.credentialDigest !== credentialDigest(request.credential)) {
          throw new Error("stdio MCP credential changed; initialize a new session");
        }
        session = existing;
      }

      return withSessionLock(session, async () => {
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
    async close(sessionId, principalKey) {
      if (!sessionId) return;
      const session = sessions.get(sessionId);
      if (!session) return;
      if (session.principalKey !== principalKey) {
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
    id: randomUUID(),
    principalKey: request.principalKey,
    credentialDigest: credentialDigest(request.credential),
    child,
    reader: child.stdout.getReader(),
    buffer: "",
    tail: Promise.resolve(),
  };
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
