#!/usr/bin/env bun

const port = Number(process.env.PORT ?? "8090");
const fixtureEmail = process.env.FIXTURE_EMAIL ?? "local.user@example.com";
const googleScopes = process.env.FIXTURE_GOOGLE_SCOPES ?? "https://www.googleapis.com/auth/drive";
const githubScopes = process.env.FIXTURE_GITHUB_SCOPES ?? "repo read:org";

const GOOGLE_ACCESS_TOKEN = "fixture-google-provider-token";
const GOOGLE_REFRESH_TOKEN = "fixture-google-refresh-token";
const GITHUB_ACCESS_TOKEN = "fixture-github-provider-token";

Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true });
    }

    if (url.pathname === "/google/authorize" || url.pathname === "/github/authorize") {
      return Response.json({ fixture: true });
    }

    if (request.method === "POST" && url.pathname === "/google/token") {
      const params = new URLSearchParams(await request.text());
      const grantType = params.get("grant_type");
      if (grantType === "authorization_code") {
        return Response.json({
          access_token: GOOGLE_ACCESS_TOKEN,
          refresh_token: GOOGLE_REFRESH_TOKEN,
          expires_in: 3600,
          scope: googleScopes,
          token_type: "Bearer",
        });
      }
      if (grantType === "refresh_token" && params.get("refresh_token") === GOOGLE_REFRESH_TOKEN) {
        return Response.json({
          access_token: GOOGLE_ACCESS_TOKEN,
          expires_in: 3600,
          scope: googleScopes,
          token_type: "Bearer",
        });
      }
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }

    if (request.method === "GET" && url.pathname === "/google/userinfo") {
      return requireProviderToken(request, GOOGLE_ACCESS_TOKEN, () =>
        Response.json({ email: fixtureEmail }),
      );
    }

    if (request.method === "POST" && url.pathname === "/github/token") {
      return Response.json({
        access_token: GITHUB_ACCESS_TOKEN,
        scope: githubScopes,
        token_type: "bearer",
      });
    }

    if (request.method === "GET" && url.pathname === "/github/emails") {
      return requireProviderToken(request, GITHUB_ACCESS_TOKEN, () =>
        Response.json([{ email: fixtureEmail, primary: true, verified: true }]),
      );
    }

    if (request.method === "POST" && url.pathname === "/github-mcp") {
      return requireProviderToken(request, GITHUB_ACCESS_TOKEN, async () => {
        const payload = (await request.json()) as Record<string, unknown>;
        const id = jsonRpcId(payload.id);
        if (payload.method === "initialize") {
          return rpcResult(id, {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "safe-github-fixture", version: "1.0.0" },
          });
        }
        if (payload.method === "tools/list") {
          return rpcResult(id, {
            tools: [
              {
                name: "github_list_pull_requests",
                description: "List fixture pull requests without external side effects.",
                inputSchema: { type: "object", properties: {}, additionalProperties: false },
              },
            ],
          });
        }
        if (
          payload.method === "tools/call" &&
          isRecord(payload.params) &&
          payload.params.name === "github_list_pull_requests"
        ) {
          return rpcResult(id, {
            content: [
              {
                type: "text",
                text: JSON.stringify([{ number: 7, title: "Fixture pull request" }]),
              },
            ],
          });
        }
        return Response.json(
          { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } },
          { status: 404 },
        );
      });
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(`Provider fixture listening on port ${String(port)}`);

async function requireProviderToken(
  request: Request,
  expected: string,
  handler: () => Response | Promise<Response>,
): Promise<Response> {
  if (request.headers.get("authorization") !== `Bearer ${expected}`) {
    return Response.json({ error: "provider credential rejected" }, { status: 401 });
  }
  return handler();
}

function rpcResult(id: string | number | null, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result });
}

function jsonRpcId(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" || value === null ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
