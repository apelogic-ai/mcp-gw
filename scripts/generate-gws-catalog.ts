interface DiscoveryMethod {
  id?: string;
  description?: string;
  httpMethod?: string;
  request?: unknown;
  supportsMediaUpload?: boolean;
  supportsMediaDownload?: boolean;
  scopes?: string[];
}

interface DiscoveryResource {
  methods?: Record<string, DiscoveryMethod>;
  resources?: Record<string, DiscoveryResource>;
}

interface DiscoveryDoc extends DiscoveryResource {
  name?: string;
  version?: string;
}

interface ServiceSpec {
  alias: string;
  apiName: string;
  version: string;
}

interface GeneratedMethod {
  alias: string;
  apiName: string;
  version: string;
  path: string[];
  command: string[];
  description: string;
  httpMethod: string;
  scopes: string[];
  hasRequest: boolean;
  supportsMediaUpload: boolean;
  supportsMediaDownload: boolean;
}

interface HelperSpec {
  alias: string;
  command: string;
  description: string;
  actionClass: "read" | "write" | "destructive";
  scopes: string[];
}

const GWS_CLI_VERSION = "0.22.5";

// Mirrors github.com/googleworkspace/cli crates/google-workspace/src/services.rs at v0.22.5.
const SERVICES: ServiceSpec[] = [
  { alias: "drive", apiName: "drive", version: "v3" },
  { alias: "sheets", apiName: "sheets", version: "v4" },
  { alias: "gmail", apiName: "gmail", version: "v1" },
  { alias: "calendar", apiName: "calendar", version: "v3" },
  { alias: "admin_reports", apiName: "admin", version: "reports_v1" },
  { alias: "docs", apiName: "docs", version: "v1" },
  { alias: "slides", apiName: "slides", version: "v1" },
  { alias: "tasks", apiName: "tasks", version: "v1" },
  { alias: "people", apiName: "people", version: "v1" },
  { alias: "chat", apiName: "chat", version: "v1" },
  { alias: "classroom", apiName: "classroom", version: "v1" },
  { alias: "forms", apiName: "forms", version: "v1" },
  { alias: "keep", apiName: "keep", version: "v1" },
  { alias: "meet", apiName: "meet", version: "v2" },
  { alias: "events", apiName: "workspaceevents", version: "v1" },
  { alias: "modelarmor", apiName: "modelarmor", version: "v1" },
  { alias: "script", apiName: "script", version: "v1" },
];

const HELPERS: HelperSpec[] = [
  {
    alias: "gmail",
    command: "+send",
    description: "Send an email with MIME construction handled by gws.",
    actionClass: "write",
    scopes: ["https://www.googleapis.com/auth/gmail.send"],
  },
  {
    alias: "gmail",
    command: "+reply",
    description: "Reply to a Gmail message while preserving thread context.",
    actionClass: "write",
    scopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
    ],
  },
  {
    alias: "gmail",
    command: "+reply-all",
    description: "Reply-all to a Gmail message while preserving thread context.",
    actionClass: "write",
    scopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
    ],
  },
  {
    alias: "gmail",
    command: "+forward",
    description: "Forward a Gmail message to new recipients.",
    actionClass: "write",
    scopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
    ],
  },
  {
    alias: "gmail",
    command: "+triage",
    description: "Show an unread inbox summary.",
    actionClass: "read",
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
  },
  {
    alias: "gmail",
    command: "+watch",
    description: "Watch for new emails and stream notifications.",
    actionClass: "write",
    scopes: ["https://www.googleapis.com/auth/gmail.modify"],
  },
  {
    alias: "gmail",
    command: "+read",
    description: "Read a Gmail message in a human-oriented format.",
    actionClass: "read",
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
  },
  {
    alias: "sheets",
    command: "+append",
    description: "Append a row to a spreadsheet.",
    actionClass: "write",
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  },
  {
    alias: "sheets",
    command: "+read",
    description: "Read values from a spreadsheet.",
    actionClass: "read",
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  },
  {
    alias: "docs",
    command: "+write",
    description: "Append text to a Google Doc.",
    actionClass: "write",
    scopes: ["https://www.googleapis.com/auth/documents"],
  },
  {
    alias: "chat",
    command: "+send",
    description: "Send a Google Chat message to a space.",
    actionClass: "write",
    scopes: ["https://www.googleapis.com/auth/chat.messages.create"],
  },
  {
    alias: "drive",
    command: "+upload",
    description: "Upload a file to Drive with automatic metadata handling.",
    actionClass: "write",
    scopes: ["https://www.googleapis.com/auth/drive"],
  },
  {
    alias: "calendar",
    command: "+insert",
    description: "Create a calendar event from simple flags.",
    actionClass: "write",
    scopes: ["https://www.googleapis.com/auth/calendar"],
  },
  {
    alias: "calendar",
    command: "+agenda",
    description: "Show upcoming calendar events.",
    actionClass: "read",
    scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
  },
  {
    alias: "script",
    command: "+push",
    description: "Replace all files in an Apps Script project with local files.",
    actionClass: "write",
    scopes: ["https://www.googleapis.com/auth/script.projects"],
  },
  {
    alias: "workflow",
    command: "+standup-report",
    description: "Build a standup summary from calendar, tasks, and Gmail.",
    actionClass: "read",
    scopes: [
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/tasks.readonly",
      "https://www.googleapis.com/auth/gmail.readonly",
    ],
  },
  {
    alias: "workflow",
    command: "+meeting-prep",
    description: "Prepare for the next meeting using calendar and linked docs.",
    actionClass: "read",
    scopes: [
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/documents.readonly",
    ],
  },
  {
    alias: "workflow",
    command: "+email-to-task",
    description: "Convert a Gmail message into a Google Tasks entry.",
    actionClass: "write",
    scopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/tasks",
    ],
  },
  {
    alias: "workflow",
    command: "+weekly-digest",
    description: "Summarize this week's meetings and unread email count.",
    actionClass: "read",
    scopes: [
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/gmail.readonly",
    ],
  },
  {
    alias: "workflow",
    command: "+file-announce",
    description: "Announce a Drive file in a Chat space.",
    actionClass: "write",
    scopes: [
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/chat.messages.create",
    ],
  },
  {
    alias: "events",
    command: "+subscribe",
    description: "Subscribe to Workspace events and stream notifications.",
    actionClass: "write",
    scopes: [
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/chat.messages",
      "https://www.googleapis.com/auth/meetings.space.created",
      "https://www.googleapis.com/auth/cloud-platform",
    ],
  },
  {
    alias: "events",
    command: "+renew",
    description: "Renew or reactivate Workspace Events subscriptions.",
    actionClass: "write",
    scopes: [
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/chat.messages",
      "https://www.googleapis.com/auth/meetings.space.created",
    ],
  },
  {
    alias: "modelarmor",
    command: "+sanitize-prompt",
    description: "Sanitize a user prompt through a Model Armor template.",
    actionClass: "read",
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  },
  {
    alias: "modelarmor",
    command: "+sanitize-response",
    description: "Sanitize a model response through a Model Armor template.",
    actionClass: "read",
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  },
  {
    alias: "modelarmor",
    command: "+create-template",
    description: "Create a new Model Armor template.",
    actionClass: "write",
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  },
];

const REVIEW_SCOPE_PATTERNS = [
  /mail\.google\.com/,
  /\/auth\/gmail\./,
  /\/auth\/drive$/,
  /\/auth\/drive\./,
  /\/auth\/admin\./,
  /\/auth\/classroom\./,
  /\/auth\/contacts/,
  /\/auth\/chat\./,
  /\/auth\/cloud-platform/,
  /\/auth\/script\./,
];

async function main(): Promise<void> {
  const methods: GeneratedMethod[] = [];
  const allScopes = new Set<string>(["openid", "https://www.googleapis.com/auth/userinfo.email"]);

  for (const service of SERVICES) {
    const doc = await fetchDiscovery(service);
    collectMethods(doc, service, [], methods, allScopes);
  }

  for (const helper of HELPERS) {
    for (const scope of helper.scopes) {
      if (isDefaultConsentScope(scope)) {
        allScopes.add(scope);
      }
    }
  }

  const reviewScopes = [...allScopes]
    .filter((scope) => REVIEW_SCOPE_PATTERNS.some((pattern) => pattern.test(scope)))
    .sort();

  const text = renderCatalog({
    methods,
    helpers: HELPERS,
    allScopes: [...allScopes].sort(),
    reviewScopes,
  });

  await Bun.write("servers/google-workspace/wrapper/src/catalog/gws-generated.ts", `${text}\n`);
}

async function fetchDiscovery(service: ServiceSpec): Promise<DiscoveryDoc> {
  const urls = [
    `https://www.googleapis.com/discovery/v1/apis/${service.apiName}/${service.version}/rest`,
    `https://${service.apiName}.googleapis.com/$discovery/rest?version=${service.version}`,
  ];

  for (const url of urls) {
    const response = await fetch(url);
    if (response.ok) {
      return (await response.json()) as DiscoveryDoc;
    }
  }

  throw new Error(`Failed to fetch ${service.apiName} ${service.version}`);
}

function collectMethods(
  resource: DiscoveryResource,
  service: ServiceSpec,
  path: string[],
  methods: GeneratedMethod[],
  allScopes: Set<string>,
): void {
  for (const [name, method] of Object.entries(resource.methods ?? {}).sort()) {
    const scopes = [...(method.scopes ?? [])].filter(isSupportedGoogleOAuthScope).sort();
    for (const scope of scopes) {
      if (isDefaultConsentScope(scope)) {
        allScopes.add(scope);
      }
    }

    methods.push({
      alias: service.alias,
      apiName: service.apiName,
      version: service.version,
      path: [...path, name],
      command: [service.alias.replaceAll("_", "-"), ...path, name],
      description: method.description?.trim() || `${service.alias} ${[...path, name].join(".")}`,
      httpMethod: method.httpMethod ?? "GET",
      scopes,
      hasRequest: method.request !== undefined,
      supportsMediaUpload: method.supportsMediaUpload === true,
      supportsMediaDownload: method.supportsMediaDownload === true,
    });
  }

  for (const [name, child] of Object.entries(resource.resources ?? {}).sort()) {
    collectMethods(child, service, [...path, name], methods, allScopes);
  }
}

function isSupportedGoogleOAuthScope(scope: string): boolean {
  return (
    scope === "openid" ||
    scope === "https://mail.google.com/" ||
    scope.startsWith("https://www.googleapis.com/auth/")
  );
}

const DEFAULT_CONSENT_EXCLUDED_PREFIXES = [
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
] as const;

function isDefaultConsentScope(scope: string): boolean {
  return !DEFAULT_CONSENT_EXCLUDED_PREFIXES.some((prefix) => scope.startsWith(prefix));
}

function renderCatalog(input: {
  methods: GeneratedMethod[];
  helpers: HelperSpec[];
  allScopes: string[];
  reviewScopes: string[];
}): string {
  const methodLiteral = JSON.stringify(input.methods, null, 2);
  const helperLiteral = JSON.stringify(input.helpers, null, 2);
  const allScopesLiteral = JSON.stringify(input.allScopes, null, 2);
  const reviewScopesLiteral = JSON.stringify(input.reviewScopes, null, 2);

  return `import { defineWorkspaceTool, type WorkspaceToolDefinition } from "./types";

// Generated by scripts/generate-gws-catalog.ts from @googleworkspace/cli ${GWS_CLI_VERSION}
// service registry and Google Discovery documents. Do not edit by hand.

const GENERATED_METHODS = ${methodLiteral} as const;

const GENERATED_HELPERS = ${helperLiteral} as const;

export const GWS_GENERATED_OAUTH_SCOPES = ${allScopesLiteral} as const;

export const GWS_OAUTH_SCOPES_REQUIRING_REVIEW = ${reviewScopesLiteral} as const;

export const GWS_GENERATED_TOOL_COUNT = GENERATED_METHODS.length + GENERATED_HELPERS.length;

export const GWS_GENERATED_TOOLS: WorkspaceToolDefinition[] = [
  ...GENERATED_METHODS.map((method) =>
    defineWorkspaceTool({
      name: toolName(["gws", method.alias, ...method.path]),
      description: method.description,
      service: method.alias,
      actionClass: actionClassForHttpMethod(method.httpMethod),
      command: [...method.command],
      scopes: selectedScopes(method.scopes),
      params: [
        {
          name: "params",
          description: "URL/path/query parameters as a JSON object passed to gws --params.",
          type: "object",
          required: false,
        },
        {
          name: "format",
          description: "Optional gws output format: json, table, yaml, or csv.",
          type: "string",
          required: false,
        },
        {
          name: "dryRun",
          description: "Validate the request locally without sending it to the API.",
          type: "boolean",
          required: false,
        },
        {
          name: "sanitize",
          description: "Optional Model Armor template for response sanitization.",
          type: "string",
          required: false,
        },
        {
          name: "output",
          description: "Optional output file path for binary responses.",
          type: "string",
          required: false,
        },
        {
          name: "pageAll",
          description: "Auto-paginate list responses, returning gws NDJSON.",
          type: "boolean",
          required: false,
        },
        {
          name: "pageLimit",
          description: "Maximum pages to fetch when pageAll is true.",
          type: "number",
          required: false,
        },
        {
          name: "pageDelay",
          description: "Delay in milliseconds between pages when pageAll is true.",
          type: "number",
          required: false,
        },
        {
          name: "extraArgs",
          description: "Advanced extra gws arguments appended after generated flags.",
          type: "array",
          items: { type: "string" },
          required: false,
        },
        ...(method.supportsMediaUpload
          ? [
              {
                name: "upload",
                description: "Local file path to upload as media content.",
                type: "string" as const,
                required: false,
              },
              {
                name: "uploadContentType",
                description: "MIME type for uploaded media content.",
                type: "string" as const,
                required: false,
              },
            ]
          : []),
      ],
      bodyParams: method.hasRequest
        ? [
            {
              name: "json",
              description: "Request body as a JSON object passed to gws --json.",
              type: "object",
              required: false,
            },
          ]
        : [],
      resultMode: "text",
      paramsJsonParam: "params",
      bodyJsonParam: method.hasRequest ? "json" : undefined,
      extraArgsParam: "extraArgs",
    }),
  ),
  ...GENERATED_HELPERS.map((helper) =>
    defineWorkspaceTool({
      name: toolName(["gws", helper.alias, helper.command.slice(1)]),
      description: helper.description,
      service: helper.alias,
      actionClass: helper.actionClass,
      command: [helper.alias, helper.command],
      scopes: [...helper.scopes],
      params: [
        {
          name: "args",
          description: "Arguments after the helper command, for example [\\"--to\\", \\"user@example.com\\"].",
          type: "array",
          items: { type: "string" },
          required: false,
        },
      ],
      resultMode: "text",
      extraArgsParam: "args",
    }),
  ),
];

function selectedScopes(scopes: readonly string[]): string[] {
  return scopes.length > 0 ? [scopes[0] ?? ""] : [];
}

function actionClassForHttpMethod(method: string): "read" | "write" | "destructive" {
  if (method === "GET") {
    return "read";
  }

  if (method === "DELETE") {
    return "destructive";
  }

  return "write";
}

function toolName(parts: readonly string[]): string {
  return parts.map(snakeCase).join("_");
}

function snakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}
`;
}

await main();
