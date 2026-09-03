import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  GWS_VISIBLE_GENERATED_TOOLS,
  GOOGLE_WORKSPACE_CATALOG_ACTION_COUNTS,
  GOOGLE_WORKSPACE_CATALOG_ID,
  GOOGLE_WORKSPACE_TOOL_GRANTS_SHA256,
  GOOGLE_WORKSPACE_TOOL_GRANTS,
  GOOGLE_WORKSPACE_TOOLS,
  classifyGoogleWorkspaceToolAction,
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

const NON_DELETE_DESTRUCTIVE_TOOLS = [
  "google_docs_batch_update",
  "gws_calendar_calendars_clear",
  "gws_calendar_calendars_transfer_ownership",
  "gws_calendar_channels_stop",
  "gws_docs_documents_batch_update",
  "gws_drive_accessproposals_resolve",
  "gws_drive_approvals_cancel",
  "gws_drive_approvals_decline",
  "gws_drive_channels_stop",
  "gws_gmail_users_messages_batch_delete",
  "gws_gmail_users_messages_trash",
  "gws_gmail_users_settings_cse_keypairs_disable",
  "gws_gmail_users_settings_cse_keypairs_obliterate",
  "gws_gmail_users_stop",
  "gws_gmail_users_threads_trash",
  "gws_meet_spaces_end_active_conference",
  "gws_sheets_spreadsheets_batch_update",
  "gws_sheets_spreadsheets_values_batch_clear",
  "gws_sheets_spreadsheets_values_batch_clear_by_data_filter",
  "gws_sheets_spreadsheets_values_clear",
  "gws_slides_presentations_batch_update",
  "gws_tasks_tasks_clear",
] as const;

describe("Google Workspace tool catalog", () => {
  test("publishes the opt-in exact visible catalog as per-service provider grants", () => {
    const tools = listGoogleWorkspaceTools(GOOGLE_WORKSPACE_CATALOG_ID);

    expect(GOOGLE_WORKSPACE_CATALOG_ID).toBe("google-workspace-cli@0.22.5/visible-v1/actions-v1");
    expect(tools).toHaveLength(280);
    expect(GOOGLE_WORKSPACE_TOOL_GRANTS).toHaveLength(280);
    expect(GOOGLE_WORKSPACE_CATALOG_ACTION_COUNTS).toEqual({
      read: 110,
      write: 120,
      destructive: 50,
    });
    const actualCounts = { read: 0, write: 0, destructive: 0 };
    for (const grant of GOOGLE_WORKSPACE_TOOL_GRANTS) {
      actualCounts[grant.action] += 1;
    }
    expect(actualCounts).toEqual(GOOGLE_WORKSPACE_CATALOG_ACTION_COUNTS);
    const canonicalGrants = JSON.stringify(
      GOOGLE_WORKSPACE_TOOL_GRANTS.map(({ provider, resource, action }) => [
        provider,
        resource,
        action,
      ]),
    );
    expect(`sha256:${createHash("sha256").update(canonicalGrants).digest("hex")}`).toBe(
      GOOGLE_WORKSPACE_TOOL_GRANTS_SHA256,
    );
    expect(new Set(GOOGLE_WORKSPACE_TOOL_GRANTS.map((grant) => grant.resource)).size).toBe(280);
    expect(
      GOOGLE_WORKSPACE_TOOL_GRANTS.map((grant) => [grant.provider, grant.resource, grant.action]),
    ).toEqual(tools.map((tool) => [tool.service, tool.name, tool.actionClass]));
  });

  test("classifies every governed visible tool and fails closed for unknown provider operations", () => {
    for (const tool of listGoogleWorkspaceTools(GOOGLE_WORKSPACE_CATALOG_ID)) {
      expect(classifyGoogleWorkspaceToolAction(tool.name)).toBe(tool.actionClass);
    }

    expect(classifyGoogleWorkspaceToolAction("google_oauth_status")).toBeUndefined();
    expect(classifyGoogleWorkspaceToolAction("google_oauth_start")).toBeUndefined();
    expect(classifyGoogleWorkspaceToolAction("future_google_tool")).toBeUndefined();
  });

  test("corrects non-DELETE destructive semantics only in the opt-in catalog", () => {
    for (const name of NON_DELETE_DESTRUCTIVE_TOOLS) {
      const legacyTool = getGoogleWorkspaceTool(name);
      const governedTool = getGoogleWorkspaceTool(name, GOOGLE_WORKSPACE_CATALOG_ID);

      expect(legacyTool.command.at(-1)).not.toBe("delete");
      expect(legacyTool.actionClass).toBe("write");
      expect(legacyTool.annotations).toEqual({ readOnlyHint: false });
      expect(governedTool.actionClass).toBe("destructive");
      expect(governedTool.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    }
  });

  test("keeps the absent-pin catalog byte-equivalent to the legacy visible surface", () => {
    const expected = [...GOOGLE_WORKSPACE_TOOLS, ...GWS_VISIBLE_GENERATED_TOOLS];
    const actual = listGoogleWorkspaceTools();
    const counts = { read: 0, write: 0, destructive: 0 };
    for (const tool of actual) counts[tool.actionClass] += 1;

    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
    expect(actual).toEqual(expected);
    expect(counts).toEqual({ read: 110, write: 142, destructive: 28 });
  });

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

  test("represents structured convenience-tool bodies as JSON values", () => {
    expect(
      getGoogleWorkspaceTool("google_docs_batch_update").inputSchema.properties?.requests,
    ).toMatchObject({
      type: "array",
      items: { type: "object" },
    });
    expect(
      getGoogleWorkspaceTool("google_calendar_events_insert").inputSchema.properties?.start,
    ).toMatchObject({
      type: "object",
    });
    expect(
      getGoogleWorkspaceTool("google_sheets_values_update").inputSchema.properties?.values,
    ).toMatchObject({
      type: "array",
      items: { type: "array" },
    });
    expect(
      getGoogleWorkspaceTool("google_gmail_drafts_create").inputSchema.properties?.message,
    ).toMatchObject({
      type: "object",
    });
  });

  test("offers inline media on upload-capable tools", () => {
    for (const name of ["google_drive_files_create", "gws_drive_files_create"]) {
      const properties = getGoogleWorkspaceTool(name).inputSchema.properties;

      expect(properties?.uploadBase64).toMatchObject({
        type: "string",
      });
      expect(properties?.uploadContentType).toMatchObject({
        type: "string",
      });
    }
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
