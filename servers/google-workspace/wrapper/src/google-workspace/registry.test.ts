import { describe, expect, test } from "bun:test";

import type { Hop1Identity } from "../../../../../shared/identity/hop1";
import { InMemoryAuditSink } from "../../../../../shared/audit/audit";
import { getGoogleWorkspaceTool } from "../catalog/google-workspace";
import { GwsExecutionError } from "../executor/gws";
import { createGoogleWorkspaceRegistry } from "./registry";

const identity: Hop1Identity = {
  profile: "google",
  issuer: "https://accounts.google.com",
  subject: "google-subject",
  email: "user@example.com",
  claims: {},
};

describe("Google Workspace request registry", () => {
  test("advertises only Google OAuth helpers before provider consent", async () => {
    const registry = createGoogleWorkspaceRegistry({
      identity,
      oauth: {
        status: {
          connected: false,
          scopesRequired: ["https://www.googleapis.com/auth/drive"],
          scopesGranted: [],
          missingScopes: ["https://www.googleapis.com/auth/drive"],
        },
        startOAuth: () =>
          Promise.resolve({ authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth" }),
      },
      tokenBroker: {
        getAccessToken: () => Promise.reject(new Error("token lookup should not run")),
      },
      executor: () => Promise.reject(new Error("executor should not run")),
    });

    expect(registry.listTools().map((tool) => tool.name)).toEqual([
      "google_oauth_status",
      "google_oauth_start",
    ]);
    expect(await registry.callTool("google_oauth_status", {})).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            connected: false,
            scopesRequired: ["https://www.googleapis.com/auth/drive"],
            scopesGranted: [],
            missingScopes: ["https://www.googleapis.com/auth/drive"],
          }),
        },
      ],
    });
    expect(await registry.callTool("google_oauth_start", {})).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
          }),
        },
      ],
    });
  });

  test("advertises OAuth helpers and the full Google catalog after consent", () => {
    const registry = createGoogleWorkspaceRegistry({
      identity,
      oauth: {
        status: {
          connected: true,
          email: identity.email,
          scopesRequired: ["https://www.googleapis.com/auth/drive"],
          scopesGranted: ["https://www.googleapis.com/auth/drive"],
          missingScopes: [],
        },
        startOAuth: () => Promise.reject(new Error("not used")),
      },
      tokenBroker: {
        getAccessToken: () => Promise.resolve("unused"),
      },
      executor: () => Promise.resolve({ ok: true }),
    });

    const names = registry.listTools().map((tool) => tool.name);
    expect(names.slice(0, 2)).toEqual(["google_oauth_status", "google_oauth_start"]);
    expect(names).toContain("google_drive_files_list");
    expect(names).toContain("google_workspace_gws");
  });

  test("lists catalog tools as MCP tools", () => {
    const registry = createGoogleWorkspaceRegistry({
      identity,
      tokenBroker: {
        getAccessToken: () => Promise.resolve("unused"),
      },
      executor: () => Promise.resolve({ ok: true }),
    });

    const tool = registry
      .listTools()
      .find((candidate) => candidate.name === "google_drive_files_list");

    expect(tool?.annotations).toEqual({ readOnlyHint: true });
  });

  test("uses the tool scopes to obtain a user token before executing gws", async () => {
    const requestedScopes: string[][] = [];
    const executed: unknown[] = [];
    const audit = new InMemoryAuditSink();
    const registry = createGoogleWorkspaceRegistry({
      identity,
      audit,
      tokenBroker: {
        getAccessToken: (_identity, scopes) => {
          requestedScopes.push(scopes);
          return Promise.resolve("access-token");
        },
      },
      executor: (request) => {
        executed.push(request);
        return Promise.resolve({ file: "created" });
      },
    });

    const result = await registry.callTool("google_drive_files_create", {
      name: "Roadmap",
    });

    expect(requestedScopes).toEqual([getGoogleWorkspaceTool("google_drive_files_create").scopes]);
    expect(executed).toEqual([
      {
        tool: getGoogleWorkspaceTool("google_drive_files_create"),
        args: { name: "Roadmap" },
        accessToken: "access-token",
      },
    ]);
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({ file: "created" }, null, 2),
        },
      ],
    });
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]?.category).toBe("tool_call");
    expect(audit.events[0]?.principal).toBe("user@example.com");
    expect(audit.events[0]?.status).toBe("allow");
    expect(audit.events[0]?.tool).toBe("google_drive_files_create");
  });

  test("uses caller-supplied scopes for the generic gws tool", async () => {
    const requestedScopes: string[][] = [];
    const registry = createGoogleWorkspaceRegistry({
      identity,
      tokenBroker: {
        getAccessToken: (_identity, scopes) => {
          requestedScopes.push(scopes);
          return Promise.resolve("access-token");
        },
      },
      executor: (request) =>
        Promise.resolve({
          tool: request.tool.name,
          argv: request.args.argv,
        }),
    });

    const result = await registry.callTool("google_workspace_gws", {
      argv: ["slides", "presentations", "get", "--params", '{"presentationId":"p1"}'],
      scopes: ["https://www.googleapis.com/auth/presentations.readonly"],
    });

    expect(requestedScopes).toEqual([["https://www.googleapis.com/auth/presentations.readonly"]]);
    expect(result.content[0]?.text).toBe(
      JSON.stringify(
        {
          tool: "google_workspace_gws",
          argv: ["slides", "presentations", "get", "--params", '{"presentationId":"p1"}'],
        },
        null,
        2,
      ),
    );
  });

  test("rejects excluded scopes for the generic gws tool before token lookup", async () => {
    let tokenCalls = 0;
    const registry = createGoogleWorkspaceRegistry({
      identity,
      tokenBroker: {
        getAccessToken: () => {
          tokenCalls += 1;
          return Promise.resolve("access-token");
        },
      },
      executor: () => Promise.resolve({ ok: true }),
    });

    expect.assertions(2);
    try {
      await registry.callTool("google_workspace_gws", {
        argv: ["classroom", "courses", "list"],
        scopes: ["https://www.googleapis.com/auth/classroom.courses.readonly"],
      });
    } catch (error) {
      expect((error as Error).message).toBe(
        "scopes contains unsupported Google Workspace scopes: https://www.googleapis.com/auth/classroom.courses.readonly",
      );
      expect(tokenCalls).toBe(0);
    }
  });

  test("returns sanitized gws failures as MCP tool errors", async () => {
    const audit = new InMemoryAuditSink();
    const registry = createGoogleWorkspaceRegistry({
      identity,
      audit,
      tokenBroker: {
        getAccessToken: () => Promise.resolve("access-token"),
      },
      executor: () =>
        Promise.reject(
          new GwsExecutionError(
            "gws exited with code 1: invalid objectId s5",
            "exit",
            "Request had invalid objectId s5",
            "token=[redacted]",
          ),
        ),
    });

    const result = await registry.callTool("gws_slides_presentations_batch_update", {
      params: { presentationId: "deck-1" },
      json: {
        requests: [
          {
            createSlide: {
              objectId: "s5",
            },
          },
        ],
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("gws exited with code 1");
    expect(result.content[0]?.text).toContain("Request had invalid objectId s5");
    expect(result.content[0]?.text).toContain("token=[redacted]");
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]?.status).toBe("error");
  });

  test("rejects missing required arguments before token lookup", async () => {
    let tokenCalls = 0;
    const registry = createGoogleWorkspaceRegistry({
      identity,
      tokenBroker: {
        getAccessToken: () => {
          tokenCalls += 1;
          return Promise.resolve("access-token");
        },
      },
      executor: () => Promise.resolve({ ok: true }),
    });

    expect.assertions(2);
    try {
      await registry.callTool("google_calendar_events_insert", {
        calendarId: "primary",
      });
    } catch (error) {
      expect((error as Error).message).toBe(
        "Missing required arguments for google_calendar_events_insert: summary, start, end",
      );
      expect(tokenCalls).toBe(0);
    }
  });

  test("runs policy before token lookup and audits denied calls", async () => {
    let tokenCalls = 0;
    let executorCalls = 0;
    const audit = new InMemoryAuditSink();
    const registry = createGoogleWorkspaceRegistry({
      identity,
      audit,
      policy: {
        decide: (input) => {
          expect(input.principal).toBe("user@example.com");
          expect(input.tool).toBe("google_drive_files_delete");
          expect(input.actionClass).toBe("destructive");
          expect(input.args).toEqual({ fileId: "file-123" });
          return Promise.resolve({ kind: "deny", reason: "delete disabled" });
        },
      },
      tokenBroker: {
        getAccessToken: () => {
          tokenCalls += 1;
          return Promise.resolve("access-token");
        },
      },
      executor: () => {
        executorCalls += 1;
        return Promise.resolve({ ok: true });
      },
    });

    expect.assertions(11);
    try {
      await registry.callTool("google_drive_files_delete", {
        fileId: "file-123",
      });
    } catch (error) {
      expect((error as Error).message).toBe(
        "Policy denied google_drive_files_delete: delete disabled",
      );
      expect(tokenCalls).toBe(0);
      expect(executorCalls).toBe(0);
      expect(audit.events).toHaveLength(1);
      expect(audit.events[0]?.status).toBe("deny");
      expect(audit.events[0]?.tool).toBe("google_drive_files_delete");
      expect(audit.events[0]?.error).toBe("delete disabled");
    }
  });

  test("treats approval-required policy results as denied without Claude-specific behavior", async () => {
    const audit = new InMemoryAuditSink();
    const registry = createGoogleWorkspaceRegistry({
      identity,
      audit,
      policy: {
        decide: () =>
          Promise.resolve({ kind: "approval_required", reason: "manager approval required" }),
      },
      tokenBroker: {
        getAccessToken: () => Promise.resolve("access-token"),
      },
      executor: () => Promise.resolve({ ok: true }),
    });

    expect.assertions(3);
    try {
      await registry.callTool("google_gmail_drafts_create", {
        userId: "me",
        message: JSON.stringify({
          to: "user@example.com",
          subject: "Hello",
          body: "Body",
        }),
      });
    } catch (error) {
      expect((error as Error).message).toBe(
        "Policy requires approval for google_gmail_drafts_create: manager approval required",
      );
      expect(audit.events[0]?.status).toBe("deny");
      expect(audit.events[0]?.event).toBe("approval_required");
    }
  });
});
