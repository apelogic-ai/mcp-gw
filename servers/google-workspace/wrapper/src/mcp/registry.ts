export interface JsonSchemaObject {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchemaObject;
  annotations: ToolAnnotations;
}

export interface ToolResultContent {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: ToolResultContent[];
  isError?: boolean;
}

export interface ToolRegistry {
  listTools(): ToolDefinition[];
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

export function hasTool(registry: ToolRegistry, name: string): boolean {
  return registry.listTools().some((tool) => tool.name === name);
}
