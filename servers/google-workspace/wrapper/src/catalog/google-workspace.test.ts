import { describe, expect, test } from "bun:test";

import {
  GWS_VISIBLE_GENERATED_TOOLS,
  GOOGLE_WORKSPACE_TOOLS,
  getGoogleWorkspaceTool,
  listGoogleWorkspaceTools,
} from "./google-workspace";
import type { WorkspaceService } from "./types";

const REQUIRED_SERVICE_GROUPS: WorkspaceService[] = [
  "calendar",
  "docs",
  "drive",
  "gmail",
  "gws",
  "meet",
  "sheets",
  "tasks",
];

describe("Google Workspace tool catalog", () => {
  test("uses federation-safe unique tool names", () => {
    const names = GOOGLE_WORKSPACE_TOOLS.map((tool) => tool.name);
    const uniqueNames = new Set(names);

    expect(uniqueNames.size).toBe(names.length);
    expect(names.every((name) => name.startsWith("google_"))).toBe(true);
  });

  test("keeps visible tool names within Claude's remote connector limit", () => {
    const longToolNames = listGoogleWorkspaceTools()
      .map((tool) => tool.name)
      .filter((name) => name.length > 64);

    expect(longToolNames).toEqual([]);
  });

  test("covers the required Workspace service groups", () => {
    const groups = new Set(GOOGLE_WORKSPACE_TOOLS.map((tool) => tool.service));

    expect([...groups].sort()).toEqual(REQUIRED_SERVICE_GROUPS);
  });

  test("keeps write and destructive operations in the product surface", () => {
    const actionClasses = new Set(GOOGLE_WORKSPACE_TOOLS.map((tool) => tool.actionClass));

    expect(actionClasses.has("read")).toBe(true);
    expect(actionClasses.has("write")).toBe(true);
    expect(actionClasses.has("destructive")).toBe(true);
  });

  test("represents required params in generated input schemas", () => {
    const tool = getGoogleWorkspaceTool("google_calendar_events_insert");

    expect(tool.inputSchema.required).toEqual(["calendarId", "summary", "start", "end"]);
    expect(tool.inputSchema.properties).toHaveProperty("calendarId");
    expect(tool.inputSchema.properties).toHaveProperty("summary");
  });

  test("converts action classes to MCP annotations", () => {
    expect(getGoogleWorkspaceTool("google_drive_files_list").annotations).toEqual({
      readOnlyHint: true,
    });
    expect(getGoogleWorkspaceTool("google_drive_files_create").annotations).toEqual({
      readOnlyHint: false,
    });
    expect(getGoogleWorkspaceTool("google_drive_files_delete").annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });

  test("exposes a full gws CLI passthrough tool for dynamic Discovery parity", () => {
    const tool = getGoogleWorkspaceTool("google_workspace_gws");

    expect(tool.service).toBe("gws");
    expect(tool.actionClass).toBe("destructive");
    expect(tool.scopes).toEqual([]);
    expect(tool.dynamicScopesParam).toBe("scopes");
    expect(tool.rawArgvParam).toBe("argv");
    expect(tool.resultMode).toBe("text");
    expect(tool.inputSchema).toMatchObject({
      type: "object",
      required: ["argv", "scopes"],
      additionalProperties: false,
      properties: {
        argv: {
          type: "array",
          items: { type: "string" },
        },
        scopes: {
          type: "array",
          items: { type: "string" },
        },
      },
    });
  });

  test("lists tools without exposing mutable internals", () => {
    const tools = listGoogleWorkspaceTools();
    tools.pop();

    expect(listGoogleWorkspaceTools()).toHaveLength(
      GOOGLE_WORKSPACE_TOOLS.length + GWS_VISIBLE_GENERATED_TOOLS.length,
    );
  });

  test("exposes generated gws Discovery methods for consented Workspace families", () => {
    const toolNames = new Set(listGoogleWorkspaceTools().map((tool) => tool.name));

    expect(toolNames.has("gws_drive_files_copy")).toBe(true);
    expect(toolNames.has("gws_slides_presentations_batch_update")).toBe(true);
    expect(toolNames.has("gws_docs_documents_batch_update")).toBe(true);
    expect(toolNames.has("gws_sheets_spreadsheets_values_update")).toBe(true);
    expect(toolNames.has("gws_tasks_tasklists_list")).toBe(true);
  });

  test("does not expose generated tools for excluded product families", () => {
    const tools = listGoogleWorkspaceTools();
    const toolNames = new Set(tools.map((tool) => tool.name));
    const services = new Set(tools.map((tool) => tool.service));
    const scopes = tools.flatMap((tool) => tool.scopes);

    expect(toolNames.has("gws_chat_spaces_messages_create")).toBe(false);
    expect(toolNames.has("gws_people_people_connections_list")).toBe(false);
    expect(toolNames.has("gws_classroom_courses_course_work_create")).toBe(false);
    expect(toolNames.has("gws_forms_forms_create")).toBe(false);
    expect(toolNames.has("gws_keep_notes_create")).toBe(false);
    expect(toolNames.has("gws_events_subscriptions_create")).toBe(false);
    expect(toolNames.has("gws_modelarmor_projects_locations_templates_create")).toBe(false);
    expect(toolNames.has("gws_script_projects_update_content")).toBe(false);

    expect([...services].sort()).not.toContain("admin_reports");
    expect([...services].sort()).not.toContain("chat");
    expect([...services].sort()).not.toContain("classroom");
    expect([...services].sort()).not.toContain("events");
    expect([...services].sort()).not.toContain("forms");
    expect([...services].sort()).not.toContain("keep");
    expect([...services].sort()).not.toContain("modelarmor");
    expect([...services].sort()).not.toContain("people");
    expect([...services].sort()).not.toContain("script");

    expect(scopes.some((scope) => scope.includes("/auth/admin."))).toBe(false);
    expect(scopes.some((scope) => scope.includes("/auth/chat"))).toBe(false);
    expect(scopes.some((scope) => scope.includes("/auth/classroom."))).toBe(false);
    expect(scopes.some((scope) => scope.includes("/auth/cloud-platform"))).toBe(false);
    expect(scopes.some((scope) => scope.includes("/auth/contacts"))).toBe(false);
    expect(scopes.some((scope) => scope.includes("/auth/directory."))).toBe(false);
    expect(scopes.some((scope) => scope.includes("/auth/forms"))).toBe(false);
    expect(scopes.some((scope) => scope.includes("/auth/groups"))).toBe(false);
    expect(scopes.some((scope) => scope.includes("/auth/keep"))).toBe(false);
    expect(scopes.some((scope) => scope.includes("/auth/script."))).toBe(false);
    expect(scopes.some((scope) => scope.includes("/auth/user."))).toBe(false);
    expect(scopes).not.toContain("https://www.googleapis.com/auth/drive.scripts");
    expect(scopes).not.toContain("https://www.googleapis.com/auth/userinfo.profile");
  });

  test("exposes gws helper commands as visible MCP tools", () => {
    const toolNames = new Set(listGoogleWorkspaceTools().map((tool) => tool.name));

    expect(toolNames.has("gws_gmail_send")).toBe(true);
    expect(toolNames.has("gws_gmail_reply_all")).toBe(true);
    expect(toolNames.has("gws_drive_upload")).toBe(true);
    expect(toolNames.has("gws_calendar_agenda")).toBe(true);
    expect(toolNames.has("gws_workflow_standup_report")).toBe(true);
    expect(toolNames.has("gws_events_subscribe")).toBe(false);
    expect(toolNames.has("gws_modelarmor_sanitize_prompt")).toBe(false);
  });

  test("attaches generated Discovery scopes to visible tools", () => {
    expect(getGoogleWorkspaceTool("gws_slides_presentations_batch_update").scopes).toEqual([
      "https://www.googleapis.com/auth/drive",
    ]);
    expect(getGoogleWorkspaceTool("gws_gmail_users_messages_send").scopes).toEqual([
      "https://mail.google.com/",
    ]);
    expect(getGoogleWorkspaceTool("gws_drive_files_copy").scopes).toEqual([
      "https://www.googleapis.com/auth/drive",
    ]);
  });
});
