import { describe, expect, test } from "bun:test";

import { captureUpstreamCatalog } from "./catalog-capture";
import type { GenericUpstreamRequest, GenericUpstreamTransport } from "./transport";

class PaginatedTransport implements GenericUpstreamTransport {
  readonly cursors: (string | undefined)[] = [];
  issued = false;
  closed = false;

  issueSession(): void {
    this.issued = true;
  }

  assertSession(sessionId: string, principalKey: string): void {
    void sessionId;
    void principalKey;
  }

  send(request: GenericUpstreamRequest): Promise<Response> {
    const message = JSON.parse(request.body) as {
      id: number;
      params?: { cursor?: string };
    };
    const cursor = message.params?.cursor;
    this.cursors.push(cursor);
    const payload = {
      jsonrpc: "2.0",
      id: message.id,
      result:
        cursor === undefined
          ? {
              tools: [{ name: "getJiraIssue", description: "Get an issue", inputSchema: {} }],
              nextCursor: "page-2",
            }
          : {
              tools: [
                {
                  name: "searchJiraIssuesUsingJql",
                  description: "Search issues",
                  inputSchema: {},
                },
              ],
            },
    };
    return Promise.resolve(
      new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      }),
    );
  }

  close(): Promise<Response | undefined> {
    this.closed = true;
    return Promise.resolve(undefined);
  }
}

describe("generic OAuth upstream catalog capture", () => {
  test("captures every page without exposing the credential in its result", async () => {
    const transport = new PaginatedTransport();
    const result = await captureUpstreamCatalog({
      transport,
      credential: {
        header: "authorization",
        value: "Bearer sensitive-token",
        rawValue: "sensitive-token",
      },
      principalKey: "issuer\nsubject",
    });

    expect(transport.issued).toBeTrue();
    expect(transport.cursors).toEqual([undefined, "page-2"]);
    expect(transport.closed).toBeTrue();
    expect(result.pages).toBe(2);
    expect(result.tools.map((tool) => tool.name)).toEqual([
      "getJiraIssue",
      "searchJiraIssuesUsingJql",
    ]);
    expect(JSON.stringify(result)).not.toContain("sensitive-token");
  });

  test("stops instead of pinning the search-only fallback catalog", () => {
    const transport: GenericUpstreamTransport = {
      issueSession(session) {
        void session;
      },
      assertSession(sessionId, principalKey) {
        void sessionId;
        void principalKey;
      },
      send: () =>
        Promise.resolve(
          Response.json({
            jsonrpc: "2.0",
            id: 1,
            result: { tools: [{ name: "search", description: "Rovo search", inputSchema: {} }] },
          }),
        ),
    };

    expect(
      captureUpstreamCatalog({
        transport,
        credential: { header: "authorization", value: "Bearer token", rawValue: "token" },
        principalKey: "issuer\nsubject",
      }),
    ).rejects.toThrow("only the credit-bearing search tool");
  });

  test("rejects duplicate tool names across pages", () => {
    let page = 0;
    const transport: GenericUpstreamTransport = {
      issueSession(session) {
        void session;
      },
      assertSession(sessionId, principalKey) {
        void sessionId;
        void principalKey;
      },
      send: () => {
        page += 1;
        return Promise.resolve(
          Response.json({
            jsonrpc: "2.0",
            id: page,
            result: {
              tools: [{ name: "getJiraIssue", description: "Get", inputSchema: {} }],
              ...(page === 1 ? { nextCursor: "again" } : {}),
            },
          }),
        );
      },
    };

    expect(
      captureUpstreamCatalog({
        transport,
        credential: { header: "authorization", value: "Bearer token", rawValue: "token" },
        principalKey: "issuer\nsubject",
      }),
    ).rejects.toThrow("duplicate tool name");
  });
});
