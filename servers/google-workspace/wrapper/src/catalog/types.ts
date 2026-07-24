import type { JsonSchemaObject, ToolAnnotations, ToolDefinition } from "../mcp/registry";

export type WorkspaceService = string;

export type ActionClass = "read" | "write" | "destructive";

export interface CatalogParam {
  name: string;
  description: string;
  type: "string" | "number" | "boolean" | "array" | "object";
  required: boolean;
  items?: Record<string, unknown>;
  additionalProperties?: boolean;
}

export interface WorkspaceToolDefinition extends ToolDefinition {
  service: WorkspaceService;
  actionClass: ActionClass;
  command: string[];
  scopes: string[];
  params: CatalogParam[];
  bodyParams?: CatalogParam[];
  defaultParams?: Record<string, unknown>;
  supportsUpload?: boolean;
  dynamicScopesParam?: string;
  rawArgvParam?: string;
  paramsJsonParam?: string;
  bodyJsonParam?: string;
  extraArgsParam?: string;
  resultMode?: "json" | "text";
}

export interface WorkspaceToolSpec {
  name: string;
  description: string;
  service: WorkspaceService;
  actionClass: ActionClass;
  command: string[];
  scopes: string[];
  params?: CatalogParam[];
  bodyParams?: CatalogParam[];
  defaultParams?: Record<string, unknown>;
  supportsUpload?: boolean;
  dynamicScopesParam?: string;
  rawArgvParam?: string;
  paramsJsonParam?: string;
  bodyJsonParam?: string;
  extraArgsParam?: string;
  resultMode?: "json" | "text";
}

export function defineWorkspaceTool(spec: WorkspaceToolSpec): WorkspaceToolDefinition {
  const params = spec.params ?? [];
  const bodyParams = spec.bodyParams ?? [];
  const uploadParams: CatalogParam[] = spec.supportsUpload
    ? [
        {
          name: "uploadBase64",
          description:
            "Base64-encoded media content transferred inline to the MCP server for upload.",
          type: "string",
          required: false,
        },
        {
          name: "uploadContentType",
          description: "MIME type for uploaded media content.",
          type: "string",
          required: false,
        },
      ]
    : [];

  return {
    name: spec.name,
    description: spec.description,
    service: spec.service,
    actionClass: spec.actionClass,
    command: spec.command,
    scopes: spec.scopes,
    params,
    bodyParams,
    defaultParams: spec.defaultParams,
    supportsUpload: spec.supportsUpload,
    dynamicScopesParam: spec.dynamicScopesParam,
    rawArgvParam: spec.rawArgvParam,
    paramsJsonParam: spec.paramsJsonParam,
    bodyJsonParam: spec.bodyJsonParam,
    extraArgsParam: spec.extraArgsParam,
    resultMode: spec.resultMode ?? "json",
    annotations: annotationsForActionClass(spec.actionClass),
    inputSchema: inputSchemaForParams([...params, ...bodyParams, ...uploadParams]),
  };
}

function annotationsForActionClass(actionClass: ActionClass): ToolAnnotations {
  if (actionClass === "read") {
    return { readOnlyHint: true };
  }

  if (actionClass === "destructive") {
    return { readOnlyHint: false, destructiveHint: true };
  }

  return { readOnlyHint: false };
}

function inputSchemaForParams(params: CatalogParam[]): JsonSchemaObject {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const param of params) {
    const schema: Record<string, unknown> = {
      type: param.type,
      description: param.description,
    };
    if (param.items) {
      schema.items = param.items;
    }
    if (param.additionalProperties !== undefined) {
      schema.additionalProperties = param.additionalProperties;
    }
    properties[param.name] = schema;

    if (param.required) {
      required.push(param.name);
    }
  }

  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}
