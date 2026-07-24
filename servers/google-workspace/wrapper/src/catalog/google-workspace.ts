import { defineWorkspaceTool, type CatalogParam, type WorkspaceToolDefinition } from "./types";
import { GWS_GENERATED_TOOLS } from "./gws-generated";

const DRIVE_SHARED_DEFAULTS = {
  includeItemsFromAllDrives: true,
  supportsAllDrives: true,
};

const DRIVE_SUPPORTS_ALL_DEFAULT = {
  supportsAllDrives: true,
};

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";
const DOCS_SCOPE = "https://www.googleapis.com/auth/documents";
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const TASKS_SCOPE = "https://www.googleapis.com/auth/tasks";
const MEET_CREATED_SCOPE = "https://www.googleapis.com/auth/meetings.space.created";
const MEET_READONLY_SCOPE = "https://www.googleapis.com/auth/meetings.space.readonly";
const MAX_REMOTE_CONNECTOR_TOOL_NAME_LENGTH = 64;

const EXCLUDED_GENERATED_SERVICE_ALIASES = new Set([
  "admin_reports",
  "chat",
  "classroom",
  "events",
  "forms",
  "keep",
  "modelarmor",
  "people",
  "script",
]);

const EXCLUDED_GENERATED_SCOPE_PREFIXES = [
  "https://www.googleapis.com/auth/admin.",
  "https://www.googleapis.com/auth/chat",
  "https://www.googleapis.com/auth/classroom.",
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/contacts",
  "https://www.googleapis.com/auth/directory.",
  "https://www.googleapis.com/auth/forms",
  "https://www.googleapis.com/auth/groups",
  "https://www.googleapis.com/auth/keep",
  "https://www.googleapis.com/auth/script.",
  "https://www.googleapis.com/auth/user.",
];

const EXCLUDED_GENERATED_SCOPES = new Set([
  "https://www.googleapis.com/auth/drive.scripts",
  "https://www.googleapis.com/auth/userinfo.profile",
]);

const stringParam = (name: string, description: string, required: boolean): CatalogParam => ({
  name,
  description,
  type: "string",
  required,
});

const numberParam = (name: string, description: string, required = false): CatalogParam => ({
  name,
  description,
  type: "number",
  required,
});

const booleanParam = (name: string, description: string, required = false): CatalogParam => ({
  name,
  description,
  type: "boolean",
  required,
});

const stringArrayParam = (name: string, description: string, required = false): CatalogParam => ({
  name,
  description,
  type: "array",
  items: { type: "string" },
  required,
});

const objectParam = (name: string, description: string, required = false): CatalogParam => ({
  name,
  description,
  type: "object",
  additionalProperties: true,
  required,
});

const objectArrayParam = (name: string, description: string, required = false): CatalogParam => ({
  name,
  description,
  type: "array",
  items: { type: "object", additionalProperties: true },
  required,
});

const nestedArrayParam = (name: string, description: string, required = false): CatalogParam => ({
  name,
  description,
  type: "array",
  items: { type: "array" },
  required,
});

export const GOOGLE_WORKSPACE_TOOLS: WorkspaceToolDefinition[] = [
  defineWorkspaceTool({
    name: "google_drive_files_list",
    description: "List files in Google Drive, including shared drives by default.",
    service: "drive",
    actionClass: "read",
    command: ["drive", "files", "list"],
    scopes: [DRIVE_SCOPE],
    params: [
      stringParam("q", "Drive search query.", false),
      numberParam("pageSize", "Maximum files to return."),
      stringParam("fields", "Partial response fields selector.", false),
      stringParam("orderBy", "Drive file sort order.", false),
    ],
    defaultParams: DRIVE_SHARED_DEFAULTS,
  }),
  defineWorkspaceTool({
    name: "google_drive_files_create",
    description: "Create a Drive file or upload local content.",
    service: "drive",
    actionClass: "write",
    command: ["drive", "files", "create"],
    scopes: [DRIVE_SCOPE],
    params: [stringParam("fields", "Partial response fields selector.", false)],
    bodyParams: [
      stringParam("name", "File name.", true),
      stringParam("mimeType", "Target MIME type.", false),
      stringArrayParam("parents", "Parent folder IDs."),
    ],
    defaultParams: DRIVE_SUPPORTS_ALL_DEFAULT,
    supportsUpload: true,
  }),
  defineWorkspaceTool({
    name: "google_drive_files_update",
    description: "Update Drive file metadata or content.",
    service: "drive",
    actionClass: "write",
    command: ["drive", "files", "update"],
    scopes: [DRIVE_SCOPE],
    params: [
      stringParam("fileId", "Drive file ID.", true),
      stringParam("fields", "Partial response fields selector.", false),
    ],
    bodyParams: [
      stringParam("name", "New file name.", false),
      stringParam("mimeType", "New MIME type.", false),
    ],
    defaultParams: DRIVE_SUPPORTS_ALL_DEFAULT,
    supportsUpload: true,
  }),
  defineWorkspaceTool({
    name: "google_drive_files_delete",
    description: "Permanently delete a Drive file.",
    service: "drive",
    actionClass: "destructive",
    command: ["drive", "files", "delete"],
    scopes: [DRIVE_SCOPE],
    params: [stringParam("fileId", "Drive file ID.", true)],
    defaultParams: DRIVE_SUPPORTS_ALL_DEFAULT,
  }),
  defineWorkspaceTool({
    name: "google_drive_permissions_create",
    description: "Share a Drive file by creating a permission.",
    service: "drive",
    actionClass: "write",
    command: ["drive", "permissions", "create"],
    scopes: [DRIVE_SCOPE],
    params: [stringParam("fileId", "Drive file ID.", true)],
    bodyParams: [
      stringParam("role", "Permission role.", true),
      stringParam("type", "Permission grantee type.", true),
      stringParam("emailAddress", "User or group email address.", false),
    ],
  }),
  defineWorkspaceTool({
    name: "google_gmail_messages_list",
    description: "Search and list Gmail messages.",
    service: "gmail",
    actionClass: "read",
    command: ["gmail", "users", "messages", "list"],
    scopes: [GMAIL_SCOPE],
    params: [
      stringParam("userId", "Gmail user ID, usually me.", true),
      stringParam("q", "Gmail search query.", false),
      numberParam("maxResults", "Maximum messages to return."),
      stringArrayParam("labelIds", "Label IDs filter."),
    ],
  }),
  defineWorkspaceTool({
    name: "google_gmail_messages_get",
    description: "Read a Gmail message.",
    service: "gmail",
    actionClass: "read",
    command: ["gmail", "users", "messages", "get"],
    scopes: [GMAIL_SCOPE],
    params: [
      stringParam("userId", "Gmail user ID, usually me.", true),
      stringParam("id", "Message ID.", true),
      stringParam("format", "Response format.", false),
    ],
  }),
  defineWorkspaceTool({
    name: "google_gmail_drafts_create",
    description: "Create a Gmail draft. Sending remains a separate explicit operation.",
    service: "gmail",
    actionClass: "write",
    command: ["gmail", "users", "drafts", "create"],
    scopes: [GMAIL_SCOPE],
    params: [stringParam("userId", "Gmail user ID, usually me.", true)],
    bodyParams: [objectParam("message", "Draft message resource.", true)],
  }),
  defineWorkspaceTool({
    name: "google_gmail_threads_modify",
    description: "Modify Gmail thread labels.",
    service: "gmail",
    actionClass: "write",
    command: ["gmail", "users", "threads", "modify"],
    scopes: [GMAIL_SCOPE],
    params: [
      stringParam("userId", "Gmail user ID, usually me.", true),
      stringParam("id", "Thread ID.", true),
    ],
    bodyParams: [
      stringArrayParam("addLabelIds", "Labels to add."),
      stringArrayParam("removeLabelIds", "Labels to remove."),
    ],
  }),
  defineWorkspaceTool({
    name: "google_calendar_events_list",
    description: "List calendar events.",
    service: "calendar",
    actionClass: "read",
    command: ["calendar", "events", "list"],
    scopes: [CALENDAR_SCOPE],
    params: [
      stringParam("calendarId", "Calendar ID, usually primary.", true),
      stringParam("timeMin", "Lower time bound as RFC3339.", false),
      stringParam("timeMax", "Upper time bound as RFC3339.", false),
      numberParam("maxResults", "Maximum events to return."),
      booleanParam("singleEvents", "Expand recurring events."),
      stringParam("q", "Free-text event search.", false),
    ],
  }),
  defineWorkspaceTool({
    name: "google_calendar_events_insert",
    description: "Create a calendar event.",
    service: "calendar",
    actionClass: "write",
    command: ["calendar", "events", "insert"],
    scopes: [CALENDAR_SCOPE],
    params: [stringParam("calendarId", "Calendar ID, usually primary.", true)],
    bodyParams: [
      stringParam("summary", "Event title.", true),
      objectParam("start", "Start time object.", true),
      objectParam("end", "End time object.", true),
      stringParam("description", "Event description.", false),
      stringParam("location", "Event location.", false),
    ],
  }),
  defineWorkspaceTool({
    name: "google_calendar_events_update",
    description: "Update a calendar event.",
    service: "calendar",
    actionClass: "write",
    command: ["calendar", "events", "update"],
    scopes: [CALENDAR_SCOPE],
    params: [
      stringParam("calendarId", "Calendar ID.", true),
      stringParam("eventId", "Event ID.", true),
    ],
    bodyParams: [
      stringParam("summary", "Event title.", false),
      objectParam("start", "Start time object."),
      objectParam("end", "End time object."),
      stringParam("description", "Event description.", false),
    ],
  }),
  defineWorkspaceTool({
    name: "google_calendar_events_delete",
    description: "Delete a calendar event.",
    service: "calendar",
    actionClass: "destructive",
    command: ["calendar", "events", "delete"],
    scopes: [CALENDAR_SCOPE],
    params: [
      stringParam("calendarId", "Calendar ID.", true),
      stringParam("eventId", "Event ID.", true),
    ],
  }),
  defineWorkspaceTool({
    name: "google_docs_get",
    description: "Read a Google Doc.",
    service: "docs",
    actionClass: "read",
    command: ["docs", "documents", "get"],
    scopes: [DOCS_SCOPE],
    params: [stringParam("documentId", "Google Doc ID.", true)],
  }),
  defineWorkspaceTool({
    name: "google_docs_create",
    description: "Create a Google Doc.",
    service: "docs",
    actionClass: "write",
    command: ["docs", "documents", "create"],
    scopes: [DOCS_SCOPE],
    bodyParams: [stringParam("title", "Document title.", true)],
  }),
  defineWorkspaceTool({
    name: "google_docs_batch_update",
    description: "Apply batch updates to a Google Doc.",
    service: "docs",
    actionClass: "write",
    command: ["docs", "documents", "batchUpdate"],
    scopes: [DOCS_SCOPE],
    params: [stringParam("documentId", "Google Doc ID.", true)],
    bodyParams: [objectArrayParam("requests", "Batch update requests.", true)],
  }),
  defineWorkspaceTool({
    name: "google_sheets_get",
    description: "Read spreadsheet metadata.",
    service: "sheets",
    actionClass: "read",
    command: ["sheets", "spreadsheets", "get"],
    scopes: [SHEETS_SCOPE],
    params: [
      stringParam("spreadsheetId", "Spreadsheet ID.", true),
      booleanParam("includeGridData", "Whether to include grid data."),
    ],
  }),
  defineWorkspaceTool({
    name: "google_sheets_values_get",
    description: "Read values from a spreadsheet range.",
    service: "sheets",
    actionClass: "read",
    command: ["sheets", "spreadsheets", "values", "get"],
    scopes: [SHEETS_SCOPE],
    params: [
      stringParam("spreadsheetId", "Spreadsheet ID.", true),
      stringParam("range", "A1 notation range.", true),
      stringParam("valueRenderOption", "Value render option.", false),
    ],
  }),
  defineWorkspaceTool({
    name: "google_sheets_values_update",
    description: "Write values to a spreadsheet range.",
    service: "sheets",
    actionClass: "write",
    command: ["sheets", "spreadsheets", "values", "update"],
    scopes: [SHEETS_SCOPE],
    params: [
      stringParam("spreadsheetId", "Spreadsheet ID.", true),
      stringParam("range", "A1 notation range.", true),
      stringParam("valueInputOption", "RAW or USER_ENTERED.", true),
    ],
    bodyParams: [nestedArrayParam("values", "Two-dimensional values array.", true)],
  }),
  defineWorkspaceTool({
    name: "google_sheets_values_append",
    description: "Append values to a spreadsheet range.",
    service: "sheets",
    actionClass: "write",
    command: ["sheets", "spreadsheets", "values", "append"],
    scopes: [SHEETS_SCOPE],
    params: [
      stringParam("spreadsheetId", "Spreadsheet ID.", true),
      stringParam("range", "A1 notation range.", true),
      stringParam("valueInputOption", "RAW or USER_ENTERED.", true),
    ],
    bodyParams: [nestedArrayParam("values", "Two-dimensional values array.", true)],
  }),
  defineWorkspaceTool({
    name: "google_tasks_tasklists_list",
    description: "List Google Tasks task lists.",
    service: "tasks",
    actionClass: "read",
    command: ["tasks", "tasklists", "list"],
    scopes: [TASKS_SCOPE],
    params: [numberParam("maxResults", "Maximum task lists to return.")],
  }),
  defineWorkspaceTool({
    name: "google_tasks_tasks_insert",
    description: "Create a Google Task.",
    service: "tasks",
    actionClass: "write",
    command: ["tasks", "tasks", "insert"],
    scopes: [TASKS_SCOPE],
    params: [stringParam("tasklist", "Task list ID.", true)],
    bodyParams: [
      stringParam("title", "Task title.", true),
      stringParam("notes", "Task notes.", false),
      stringParam("due", "Due date as RFC3339.", false),
    ],
  }),
  defineWorkspaceTool({
    name: "google_tasks_tasks_update",
    description: "Update a Google Task.",
    service: "tasks",
    actionClass: "write",
    command: ["tasks", "tasks", "update"],
    scopes: [TASKS_SCOPE],
    params: [stringParam("tasklist", "Task list ID.", true), stringParam("task", "Task ID.", true)],
    bodyParams: [
      stringParam("title", "Task title.", true),
      stringParam("notes", "Task notes.", false),
      stringParam("status", "Task status.", false),
      stringParam("due", "Due date as RFC3339.", false),
    ],
  }),
  defineWorkspaceTool({
    name: "google_tasks_tasks_delete",
    description: "Delete a Google Task.",
    service: "tasks",
    actionClass: "destructive",
    command: ["tasks", "tasks", "delete"],
    scopes: [TASKS_SCOPE],
    params: [stringParam("tasklist", "Task list ID.", true), stringParam("task", "Task ID.", true)],
  }),
  defineWorkspaceTool({
    name: "google_meet_spaces_get",
    description: "Read a Google Meet space.",
    service: "meet",
    actionClass: "read",
    command: ["meet", "spaces", "get"],
    scopes: [MEET_READONLY_SCOPE],
    params: [stringParam("name", "Meet space resource name.", true)],
  }),
  defineWorkspaceTool({
    name: "google_meet_spaces_create",
    description: "Create a Google Meet space.",
    service: "meet",
    actionClass: "write",
    command: ["meet", "spaces", "create"],
    scopes: [MEET_CREATED_SCOPE],
    bodyParams: [objectParam("config", "Meet space config.")],
  }),
  defineWorkspaceTool({
    name: "google_workspace_gws",
    description:
      "Run any supported gws CLI command, including dynamic Discovery methods, helper commands, schema introspection, pagination, dry-run, uploads, downloads, and future Workspace APIs.",
    service: "gws",
    actionClass: "destructive",
    command: [],
    scopes: [],
    params: [
      stringArrayParam(
        "argv",
        'Arguments after the gws binary. Example: ["drive", "files", "list", "--params", "{\\"pageSize\\":5}"].',
        true,
      ),
      stringArrayParam(
        "scopes",
        "OAuth scopes required for this exact command. Use [] only for commands that do not need Google API credentials, such as schema/help/dry-run inspection.",
        true,
      ),
    ],
    dynamicScopesParam: "scopes",
    rawArgvParam: "argv",
    resultMode: "text",
  }),
];

export const GWS_VISIBLE_GENERATED_TOOLS = GWS_GENERATED_TOOLS.filter(isVisibleGeneratedTool);

const GOOGLE_WORKSPACE_TOOL_BY_NAME = new Map(
  [...GOOGLE_WORKSPACE_TOOLS, ...GWS_VISIBLE_GENERATED_TOOLS].map((tool) => [tool.name, tool]),
);

export function listGoogleWorkspaceTools(): WorkspaceToolDefinition[] {
  return [...GOOGLE_WORKSPACE_TOOLS, ...GWS_VISIBLE_GENERATED_TOOLS];
}

export function getGoogleWorkspaceTool(name: string): WorkspaceToolDefinition {
  const tool = GOOGLE_WORKSPACE_TOOL_BY_NAME.get(name);
  if (!tool) {
    throw new Error(`Unknown Google Workspace tool: ${name}`);
  }

  return tool;
}

function isVisibleGeneratedTool(tool: WorkspaceToolDefinition): boolean {
  if (tool.name.length > MAX_REMOTE_CONNECTOR_TOOL_NAME_LENGTH) {
    return false;
  }

  if (EXCLUDED_GENERATED_SERVICE_ALIASES.has(tool.service)) {
    return false;
  }

  return !tool.scopes.some(isExcludedGoogleWorkspaceScope);
}

export function isExcludedGoogleWorkspaceScope(scope: string): boolean {
  if (EXCLUDED_GENERATED_SCOPES.has(scope)) {
    return true;
  }

  return EXCLUDED_GENERATED_SCOPE_PREFIXES.some((prefix) => scope.startsWith(prefix));
}
