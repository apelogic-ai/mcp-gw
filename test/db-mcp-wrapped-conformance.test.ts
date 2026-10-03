import { describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { parse, parseAllDocuments } from "yaml";

import { InMemoryAuditSink } from "../shared/audit/audit";
import type { PolicyDecision } from "../shared/policy/policy";
import { createAuthenticator } from "../packages/wrapper-kit/src/authenticator";
import {
  runBackendConformance,
  type BackendConformanceScenario,
} from "../packages/backend-conformance/src/index";
import {
  parseGenericToolCatalog,
  parseGenericWrapperDescriptor,
} from "../servers/generic-wrapper/src/descriptor";
import { createGenericMcpProxyHandler } from "../servers/generic-wrapper/src/proxy";
import { createHttpUpstreamTransport } from "../servers/generic-wrapper/src/transport";

describe("opt-in wrapped db-mcp mode", () => {
  test("passes the backend contract using the chart-rendered descriptor and catalog", async () => {
    const rendered = renderExample();
    const config = parseAllDocuments(rendered)
      .map((document) => document.toJSON() as Record<string, unknown>)
      .find(
        (resource) =>
          resource.kind === "ConfigMap" &&
          (resource.metadata as { name?: string } | undefined)?.name ===
            "mcp-gateway-db-mcp-wrapper-config",
      );
    const data = config?.data as Record<string, string> | undefined;
    const descriptor = parseGenericWrapperDescriptor(parse(data?.["descriptor.yaml"] ?? ""));
    const catalog = parseGenericToolCatalog(
      parse(data?.["catalog.yaml"] ?? ""),
      descriptor.toolPrefix,
    );
    if (descriptor.upstream.transport !== "http") {
      throw new Error("db-mcp wrapper must use HTTP loopback");
    }

    const tokens = await tokenFixture();
    const audit = new InMemoryAuditSink();
    const upstreamEvidence: string[] = [];
    let scenario: BackendConformanceScenario = "normal";
    const transport = createHttpUpstreamTransport(descriptor.upstream, {
      fetch: (_input, init) => {
        const body = typeof init?.body === "string" ? init.body : "{}";
        upstreamEvidence.push(
          JSON.stringify({
            headers: Object.fromEntries(new Headers(init?.headers)),
            body,
          }),
        );
        if (scenario === "upstream_5xx") {
          return Promise.resolve(Response.json({ error: "db unavailable" }, { status: 503 }));
        }
        if (scenario === "upstream_timeout") {
          return Promise.reject(new DOMException("db fixture timeout", "TimeoutError"));
        }
        const payload = JSON.parse(body) as {
          id?: string | number | null;
          method?: string;
        };
        if (payload.method === "notifications/initialized") {
          return Promise.resolve(new Response(null, { status: 202 }));
        }
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
                      serverInfo: { name: "db-mcp-fixture", version: "1" },
                    }
                  : { content: [{ type: "text", text: "fixture protocol" }] },
            },
            { headers: { "mcp-session-id": "db-upstream-session" } },
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
      authenticate: tokens.authenticate,
      transport,
      audit,
      policy: {
        decide(): Promise<PolicyDecision> {
          return Promise.resolve(
            scenario === "policy_denied"
              ? { kind: "deny", ruleId: "db-conformance-deny", reason: "fixture denial" }
              : { kind: "allow" },
          );
        },
      },
      resolveCredential: () => Promise.resolve(null),
    });

    const report = await runBackendConformance({
      name: "wrapped db-mcp",
      endpoint: "http://db-mcp-wrapper.test/mcp",
      send: handler,
      tokens,
      sessionMode: "required",
      policyDenial: "mcp_tool_error",
      toolCall: { name: "db_protocol", arguments: {} },
      scenarios: {
        policyDenied: {
          activate: () => {
            scenario = "policy_denied";
          },
        },
        upstream5xx: {
          activate: () => {
            scenario = "upstream_5xx";
          },
        },
        upstreamTimeout: {
          activate: () => {
            scenario = "upstream_timeout";
          },
        },
        reset: () => {
          scenario = "normal";
        },
      },
      evidence: {
        upstream: () => upstreamEvidence,
        logs: () => JSON.stringify(audit.events),
        forbiddenUpstreamValues: Object.values(tokens).filter(
          (value): value is string => typeof value === "string",
        ),
        forbiddenOutputValues: Object.values(tokens).filter(
          (value): value is string => typeof value === "string",
        ),
      },
    });

    expect(report.failures).toEqual([]);
    expect(report.passed).toContain("security.hop1_not_forwarded");
    expect(upstreamEvidence.join("\n")).not.toContain("authorization");
  });
});

function renderExample(): string {
  const result = Bun.spawnSync({
    cmd: [
      "helm",
      "template",
      "mcp-gateway",
      "deploy/k8s/chart",
      "--values",
      "deploy/k8s/examples/values-db-mcp-wrapped.example.yaml",
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`Helm render failed: ${result.stderr.toString().slice(0, 1024)}`);
  }
  return result.stdout.toString();
}

async function tokenFixture(): Promise<{
  valid: string;
  expired: string;
  wrongAudience: string;
  otherPrincipal: string;
  authenticate: ReturnType<typeof createAuthenticator>;
}> {
  const issuer = "https://identity.example.com";
  const audience = "mcp-gateway";
  const signing = await generateKeyPair("EdDSA");
  const publicJwk: JWK = await exportJWK(signing.publicKey);
  publicJwk.kid = "db-conformance-key";
  const authenticate = createAuthenticator({
    issuers: [
      {
        profile: {
          name: "db-conformance",
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
      .setProtectedHeader({ alg: "EdDSA", kid: "db-conformance-key" })
      .setIssuer(issuer)
      .setSubject(subject)
      .setAudience(tokenAudience)
      .setIssuedAt()
      .setExpirationTime(expiration)
      .sign(signing.privateKey);
  return {
    valid: await sign("db-user-one", audience, "5m"),
    expired: await sign("db-user-one", audience, "-1s"),
    wrongAudience: await sign("db-user-one", "wrong-audience", "5m"),
    otherPrincipal: await sign("db-user-two", audience, "5m"),
    authenticate,
  };
}
