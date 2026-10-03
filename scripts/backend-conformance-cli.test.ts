import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";

const VALID_TOKEN = "cli-valid-token-secret";
const EXPIRED_TOKEN = "cli-expired-token-secret";
const WRONG_AUDIENCE_TOKEN = "cli-wrong-audience-secret";
let server: ReturnType<typeof Bun.serve>;
let directory = "";
let configPath = "";

beforeAll(async () => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const authorization = request.headers.get("authorization");
      if (!authorization) return unauthorized("Bearer", "bearer token is required");
      if (authorization !== `Bearer ${VALID_TOKEN}`) {
        return unauthorized('Bearer error="invalid_token"', "invalid bearer token");
      }
      const payload = (await request.json()) as {
        id?: string | number | null;
        method?: string;
      };
      const path = new URL(request.url).pathname;
      if (payload.method === "tools/call" && path === "/policy-denied") {
        return rpc(payload.id, {
          isError: true,
          content: [{ type: "text", text: "denied" }],
          structuredContent: { error: "policy_denied" },
        });
      }
      if (payload.method === "tools/call" && path === "/upstream-timeout") {
        await Bun.sleep(100);
        return Response.json({ error: "fixture remained unavailable" }, { status: 503 });
      }
      if (
        payload.method === "tools/call" &&
        ["/upstream-5xx", "/gateway-fail-closed"].includes(path)
      ) {
        return Response.json({ error: "fixture unavailable" }, { status: 503 });
      }
      if (payload.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      if (payload.method === "initialize") {
        return rpc(payload.id, {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "cli-fixture", version: "1.0.0" },
        });
      }
      if (payload.method === "tools/list") {
        return rpc(payload.id, {
          tools: [
            {
              name: "fixture_echo",
              description: "Echo a marker.",
              inputSchema: { type: "object" },
              annotations: { readOnlyHint: true },
            },
          ],
        });
      }
      return rpc(payload.id, { content: [{ type: "text", text: "ok" }] });
    },
  });
  directory = await mkdtemp(join(tmpdir(), "mcp-gw-backend-conformance-"));
  configPath = join(directory, "config.yaml");
  await writeFile(
    configPath,
    stringify({
      schemaVersion: "mcp-gateway.backend-conformance/v1",
      name: "CLI fixture",
      url: `http://127.0.0.1:${String(server.port)}/mcp`,
      sessionMode: "optional",
      policyDenial: "mcp_tool_error",
      tokens: {
        validEnv: "FIXTURE_VALID_TOKEN",
        expiredEnv: "FIXTURE_EXPIRED_TOKEN",
        wrongAudienceEnv: "FIXTURE_WRONG_AUDIENCE_TOKEN",
      },
      toolCall: { name: "fixture_echo", arguments: { message: "hello" } },
      concurrency: 2,
      requestTimeoutMs: 25,
      scenarios: {
        policyDenied: { url: `http://127.0.0.1:${String(server.port)}/policy-denied` },
        upstream5xx: { url: `http://127.0.0.1:${String(server.port)}/upstream-5xx` },
        upstreamTimeout: { url: `http://127.0.0.1:${String(server.port)}/upstream-timeout` },
        gatewayFailOpen: { url: `http://127.0.0.1:${String(server.port)}/gateway-fail-open` },
        gatewayFailClosed: {
          url: `http://127.0.0.1:${String(server.port)}/gateway-fail-closed`,
        },
      },
    }),
  );
});

afterAll(async () => {
  await server.stop(true);
  await rm(directory, { recursive: true, force: true });
});

describe("backend conformance CLI", () => {
  test("runs the portable URL profile without printing credentials", async () => {
    const subprocess = Bun.spawn(
      [processExecPath(), "run", "conformance:backend", "--config", configPath],
      {
        env: {
          ...process.env,
          FIXTURE_VALID_TOKEN: VALID_TOKEN,
          FIXTURE_EXPIRED_TOKEN: EXPIRED_TOKEN,
          FIXTURE_WRONG_AUDIENCE_TOKEN: WRONG_AUDIENCE_TOKEN,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
    ]);

    expect(exitCode, stderr).toBe(0);
    const report = JSON.parse(stdout) as {
      failures: unknown[];
      passed: string[];
      skipped: { check: string }[];
    };
    expect(report.failures).toEqual([]);
    expect(report.passed).toContain("protocol.tools_call");
    expect(report.passed).toContain("policy.denied_grant");
    expect(report.passed).toContain("routing.fail_open");
    expect(report.passed).toContain("routing.fail_closed");
    for (const secret of [VALID_TOKEN, EXPIRED_TOKEN, WRONG_AUDIENCE_TOKEN]) {
      expect(stdout).not.toContain(secret);
      expect(stderr).not.toContain(secret);
    }
  });
});

function unauthorized(challenge: string, message: string): Response {
  return Response.json(
    { jsonrpc: "2.0", id: null, error: { code: -32001, message: `Unauthorized: ${message}` } },
    { status: 401, headers: { "www-authenticate": challenge } },
  );
}

function rpc(id: string | number | null | undefined, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, result });
}

function processExecPath(): string {
  return process.execPath;
}
