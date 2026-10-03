import { describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";

import { InMemoryAuditSink } from "../shared/audit/audit";
import type { Hop1Identity } from "../shared/identity/hop1";
import type { PolicyDecision, ToolPolicy } from "../shared/policy/policy";
import { createAuthenticator } from "../packages/wrapper-kit/src/authenticator";
import { createGenericMcpProxyHandler } from "../servers/generic-wrapper/src/proxy";
import { createHttpUpstreamTransport } from "../servers/generic-wrapper/src/transport";
import type {
  GenericToolCatalog,
  GenericWrapperDescriptor,
} from "../servers/generic-wrapper/src/descriptor";
import { createGithubMcpProxyHandler } from "../servers/github-mcp/wrapper/src/proxy";
import { createGoogleWorkspaceWrapperHandler } from "../servers/google-workspace/wrapper/src/app";
import {
  runBackendConformance,
  type BackendConformanceScenario,
  type BackendConformanceTarget,
} from "../packages/backend-conformance/src/index";

const PROVIDER_CREDENTIAL = "provider-credential-conformance-secret";
const tokensPromise = createTokenFixture();

describe("bundled wrapper backend conformance", () => {
  test.each([
    ["generic wrapper", createGenericTarget],
    ["GitHub wrapper", createGithubTarget],
    ["Google Workspace wrapper", createGoogleTarget],
  ] as const)("%s passes the shared contract", async (_name, createTarget) => {
    const report = await runBackendConformance(await createTarget());

    expect(report.failures).toEqual([]);
    for (const checkName of [
      "authentication.missing",
      "authentication.expired",
      "authentication.wrong_audience",
      "protocol.initialize",
      "protocol.initialized_notification",
      "protocol.tools_list",
      "protocol.tools_call",
      "concurrency.parallel_reads",
      "policy.denied_grant",
      "failure.upstream_5xx",
      "failure.upstream_timeout",
      "security.hop1_not_forwarded",
      "security.secret_safe_outputs",
    ]) {
      expect(report.passed).toContain(checkName);
    }
  });

  test("GitHub sidecar loopback target passes the shared contract", async () => {
    const target = await createGithubTarget("http://127.0.0.1:8082/mcp");
    const report = await runBackendConformance(target);

    expect(report.failures).toEqual([]);
    expect((await target.evidence?.upstream())?.join("\n")).toContain("http://127.0.0.1:8082/mcp");
  });
});

async function createGenericTarget(): Promise<BackendConformanceTarget> {
  const tokens = await tokensPromise;
  const audit = new InMemoryAuditSink();
  let scenario: BackendConformanceScenario = "normal";
  const upstreamEvidence: string[] = [];
  const policy = scenarioPolicy(() => scenario);
  const upstream = {
    transport: "http" as const,
    url: "http://upstream.example/mcp",
    timeoutMs: 20,
  };
  const descriptor: GenericWrapperDescriptor = {
    schemaVersion: "mcp-gateway.generic-wrapper/v1",
    name: "conformance-generic",
    toolPrefix: "reference",
    catalogPath: "/unused/catalog.yaml",
    lifecycleRoutes: false,
    upstream,
    credential: { mode: "static_secret", env: "REFERENCE_TOKEN", header: "authorization" },
    serverInfo: { name: "generic-conformance", version: "1.0.0" },
    sessions: { maxTotal: 8, maxPerPrincipal: 2, idleTtlMs: 60_000 },
  };
  const catalog: GenericToolCatalog = {
    schemaVersion: "mcp-gateway.generic-catalog/v1",
    catalogId: "conformance-generic@1",
    tools: [
      {
        exposedName: "reference_echo",
        upstreamName: "echo",
        description: "Echo a conformance marker.",
        inputSchema: { type: "object", properties: { message: { type: "string" } } },
        annotations: { readOnlyHint: true },
        grants: { actionClass: "read", operation: "reference.echo", scopes: [] },
      },
    ],
  };
  const transport = createHttpUpstreamTransport(upstream, {
    fetch: (_input, init) => {
      const body = typeof init?.body === "string" ? init.body : "{}";
      upstreamEvidence.push(
        JSON.stringify({
          headers: Object.fromEntries(new Headers(init?.headers)),
          body,
        }),
      );
      if (scenario === "upstream_5xx") {
        return Promise.resolve(Response.json({ error: "fixture unavailable" }, { status: 503 }));
      }
      if (scenario === "upstream_timeout") {
        return Promise.reject(new DOMException("fixture timeout", "TimeoutError"));
      }
      const payload = JSON.parse(body) as {
        id?: string | number | null;
        method?: string;
      };
      if (payload.method === "notifications/initialized")
        return Promise.resolve(new Response(null, { status: 202 }));
      return Promise.resolve(
        Response.json(
          {
            jsonrpc: "2.0",
            id: payload.id ?? null,
            result:
              payload.method === "initialize"
                ? {
                    protocolVersion: "2025-06-18",
                    capabilities: { tools: {} },
                    serverInfo: { name: "fixture-upstream", version: "1" },
                  }
                : { content: [{ type: "text", text: "ok" }] },
          },
          { headers: { "mcp-session-id": "fixture-upstream-session" } },
        ),
      );
    },
    serverInfo: descriptor.serverInfo,
    maxSessions: descriptor.sessions.maxTotal,
    maxSessionsPerPrincipal: descriptor.sessions.maxPerPrincipal,
    sessionIdleTtlMs: descriptor.sessions.idleTtlMs,
  });
  const handler = createGenericMcpProxyHandler({
    descriptor,
    catalog,
    authenticate: (token) => tokens.authenticate(token),
    transport,
    policy,
    audit,
    resolveCredential: () =>
      Promise.resolve({ header: "authorization", value: `Bearer ${PROVIDER_CREDENTIAL}` }),
  });

  return target({
    name: "generic wrapper",
    send: handler,
    tokens,
    sessionMode: "required",
    policyDenial: "mcp_tool_error",
    toolCall: { name: "reference_echo", arguments: { message: "conformance" } },
    scenario: (value) => {
      scenario = value;
    },
    upstreamEvidence,
    logs: () => JSON.stringify(audit.events),
  });
}

async function createGithubTarget(
  upstreamUrl = "http://github-upstream.example/mcp",
): Promise<BackendConformanceTarget> {
  const tokens = await tokensPromise;
  const audit = new InMemoryAuditSink();
  let scenario: BackendConformanceScenario = "normal";
  const upstreamEvidence: string[] = [];
  const handler = createGithubMcpProxyHandler({
    upstreamUrl,
    githubToolsets: ["repos"],
    authenticate: (token) => tokens.authenticate(token),
    getOAuthStatus: () =>
      Promise.resolve({
        connected: true,
        scopesRequired: ["repo"],
        scopesGranted: ["repo"],
        missingScopes: [],
      }),
    resolveGithubToken: () => Promise.resolve(PROVIDER_CREDENTIAL),
    policy: scenarioPolicy(() => scenario),
    audit,
    fetch: async (request) => {
      upstreamEvidence.push(
        JSON.stringify({
          url: request.url,
          headers: Object.fromEntries(request.headers),
          body: await request.clone().text(),
        }),
      );
      if (scenario === "upstream_5xx") {
        return Response.json({ error: "fixture unavailable" }, { status: 503 });
      }
      if (scenario === "upstream_timeout") {
        throw new DOMException("fixture timeout", "TimeoutError");
      }
      const payload = (await request.json()) as { id?: string | number | null };
      return Response.json({
        jsonrpc: "2.0",
        id: payload.id ?? null,
        result: { content: [{ type: "text", text: "ok" }] },
      });
    },
  });

  return target({
    name: "GitHub wrapper",
    send: handler,
    tokens,
    sessionMode: "optional",
    policyDenial: "jsonrpc_error",
    toolCall: {
      name: "get_file_contents",
      arguments: { owner: "example", repo: "fixture", path: "README.md" },
    },
    scenario: (value) => {
      scenario = value;
    },
    upstreamEvidence,
    logs: () => JSON.stringify(audit.events),
  });
}

async function createGoogleTarget(): Promise<BackendConformanceTarget> {
  const tokens = await tokensPromise;
  const audit = new InMemoryAuditSink();
  let scenario: BackendConformanceScenario = "normal";
  const upstreamEvidence: string[] = [];
  const handler = createGoogleWorkspaceWrapperHandler({
    serverInfo: { name: "google-conformance", version: "1.0.0" },
    authenticate: (token) => tokens.authenticate(token),
    policy: scenarioPolicy(() => scenario),
    audit,
    tokenBroker: {
      getGrantedScopes: () => Promise.resolve(["https://www.googleapis.com/auth/drive"]),
      getAccessToken: () => Promise.resolve(PROVIDER_CREDENTIAL),
    },
    executor: (request) => {
      upstreamEvidence.push(
        JSON.stringify({ accessToken: request.accessToken, tool: request.tool.name }),
      );
      if (scenario === "upstream_5xx") throw new Error("provider returned 503");
      if (scenario === "upstream_timeout") {
        throw new DOMException("fixture timeout", "TimeoutError");
      }
      return Promise.resolve({ files: [] });
    },
  });

  return target({
    name: "Google Workspace wrapper",
    send: handler,
    tokens,
    sessionMode: "optional",
    policyDenial: "transport_error",
    toolCall: { name: "google_drive_files_list", arguments: { pageSize: 1 } },
    scenario: (value) => {
      scenario = value;
    },
    upstreamEvidence,
    logs: () => JSON.stringify(audit.events),
  });
}

function target(options: {
  name: string;
  send(request: Request): Promise<Response>;
  tokens: TokenFixture;
  sessionMode: "required" | "optional";
  policyDenial: BackendConformanceTarget["policyDenial"];
  toolCall: { name: string; arguments: Record<string, unknown> };
  scenario(value: BackendConformanceScenario): void;
  upstreamEvidence: string[];
  logs: () => string;
}): BackendConformanceTarget {
  return {
    name: options.name,
    endpoint: "http://wrapper.test/mcp",
    send: (request) => options.send(request),
    tokens: {
      valid: options.tokens.valid,
      expired: options.tokens.expired,
      wrongAudience: options.tokens.wrongAudience,
      otherPrincipal: options.tokens.otherPrincipal,
    },
    sessionMode: options.sessionMode,
    policyDenial: options.policyDenial,
    toolCall: options.toolCall,
    concurrency: 4,
    scenarios: {
      policyDenied: { activate: () => options.scenario("policy_denied") },
      upstream5xx: { activate: () => options.scenario("upstream_5xx") },
      upstreamTimeout: { activate: () => options.scenario("upstream_timeout") },
      reset: () => options.scenario("normal"),
    },
    evidence: {
      upstream: () => options.upstreamEvidence,
      logs: () => options.logs(),
      forbiddenUpstreamValues: [
        options.tokens.valid,
        options.tokens.expired,
        options.tokens.wrongAudience,
        options.tokens.otherPrincipal,
      ],
      requiredUpstreamValues: [PROVIDER_CREDENTIAL],
      forbiddenOutputValues: [
        options.tokens.valid,
        options.tokens.expired,
        options.tokens.wrongAudience,
        options.tokens.otherPrincipal,
        PROVIDER_CREDENTIAL,
      ],
    },
  };
}

function scenarioPolicy(current: () => BackendConformanceScenario): ToolPolicy {
  return {
    decide(): Promise<PolicyDecision> {
      return Promise.resolve(
        current() === "policy_denied"
          ? { kind: "deny", ruleId: "conformance-deny", reason: "conformance denial" }
          : { kind: "allow" },
      );
    },
  };
}

interface TokenFixture {
  valid: string;
  expired: string;
  wrongAudience: string;
  otherPrincipal: string;
  authenticate(token: string): Promise<Hop1Identity>;
}

async function createTokenFixture(): Promise<TokenFixture> {
  const issuer = "https://identity.example.com";
  const audience = "mcp-gateway";
  const signing = await generateKeyPair("EdDSA");
  const publicJwk: JWK = await exportJWK(signing.publicKey);
  publicJwk.kid = "conformance-key";
  const authenticate = createAuthenticator({
    issuers: [
      {
        profile: {
          name: "conformance",
          issuer,
          audiences: [audience],
          allowedAlgorithms: ["EdDSA"],
          emailClaim: "email",
          subjectClaim: "sub",
        },
        jwksProvider: () => Promise.resolve([publicJwk]),
      },
    ],
  });
  const sign = (subject: string, tokenAudience: string, expiration: string) =>
    new SignJWT({ email: `${subject}@example.com` })
      .setProtectedHeader({ alg: "EdDSA", kid: "conformance-key" })
      .setIssuer(issuer)
      .setSubject(subject)
      .setAudience(tokenAudience)
      .setIssuedAt()
      .setExpirationTime(expiration)
      .sign(signing.privateKey);

  return {
    valid: await sign("user-one", audience, "5m"),
    expired: await sign("user-one", audience, "-1s"),
    wrongAudience: await sign("user-one", "wrong-audience", "5m"),
    otherPrincipal: await sign("user-two", audience, "5m"),
    authenticate,
  };
}
