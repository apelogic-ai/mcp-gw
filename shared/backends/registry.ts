export interface BackendDescriptor {
  name: string;
  host: string;
  toolPrefix: string;
  enabledByDefault: boolean;
}

export interface RenderBackendOptions {
  includeOptional?: boolean;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/u;
const TOOL_PREFIX_PATTERN = /^[a-z][a-z0-9_]*$/u;

export function parseBackendDescriptor(content: string): BackendDescriptor {
  const fields = parseFlatYaml(content);
  const name = requiredField(fields, "name");
  const host = requiredField(fields, "host");
  const toolPrefix = requiredField(fields, "toolPrefix");
  const enabledByDefault = parseBooleanField(fields.get("enabledByDefault") ?? "true");

  const descriptor = {
    name,
    host,
    toolPrefix,
    enabledByDefault,
  };

  validateBackendDescriptor(descriptor);
  return descriptor;
}

export function validateBackendRegistry(descriptors: BackendDescriptor[]): void {
  const names = new Set<string>();
  const toolPrefixes = new Set<string>();

  for (const descriptor of descriptors) {
    validateBackendDescriptor(descriptor);

    if (names.has(descriptor.name)) {
      throw new Error(`Duplicate backend name: ${descriptor.name}`);
    }
    names.add(descriptor.name);

    if (toolPrefixes.has(descriptor.toolPrefix)) {
      throw new Error(`Duplicate backend tool prefix: ${descriptor.toolPrefix}`);
    }
    toolPrefixes.add(descriptor.toolPrefix);
  }
}

export function renderAgentgatewayConfig(
  descriptors: BackendDescriptor[],
  options: RenderBackendOptions = {},
): string {
  return `binds:
  - port: 3000
    listeners:
      - routes:
          - matches:
              - path:
                  exact: /mcp
              - path:
                  exact: /.well-known/oauth-protected-resource/mcp
            policies:
              cors:
                allowOrigins: ["*"]
                allowHeaders: [mcp-protocol-version, content-type, authorization]
                exposeHeaders: ["Mcp-Session-Id"]
            backends:
              - mcp:
                  targets:
${renderAgentgatewayTargets(descriptors, options)}
`;
}

export function renderAgentgatewayTargets(
  descriptors: BackendDescriptor[],
  options: RenderBackendOptions = {},
): string {
  validateBackendRegistry(descriptors);

  return descriptors
    .filter((descriptor) => options.includeOptional === true || descriptor.enabledByDefault)
    .map(
      (descriptor) => `                    - name: ${descriptor.name}
                      policies:
                        backendAuth:
                          passthrough: {}
                      mcp:
                        host: ${descriptor.host}`,
    )
    .join("\n");
}

function validateBackendDescriptor(descriptor: BackendDescriptor): void {
  if (!NAME_PATTERN.test(descriptor.name)) {
    throw new Error(`Invalid backend name: ${descriptor.name}`);
  }
  if (!TOOL_PREFIX_PATTERN.test(descriptor.toolPrefix)) {
    throw new Error(`Invalid backend tool prefix: ${descriptor.toolPrefix}`);
  }
  if (!descriptor.host.startsWith("http://") && !descriptor.host.startsWith("https://")) {
    throw new Error(`Backend host must be an HTTP URL: ${descriptor.name}`);
  }
  if (!descriptor.host.endsWith("/mcp")) {
    throw new Error(`Backend host must point at an MCP endpoint: ${descriptor.name}`);
  }
}

function parseFlatYaml(content: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf(":");
    if (separatorIndex <= 0) {
      throw new Error(`Invalid backend descriptor line: ${trimmed}`);
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    fields.set(key, stripYamlQuotes(value));
  }

  return fields;
}

function requiredField(fields: Map<string, string>, name: string): string {
  const value = fields.get(name);
  if (!value) {
    throw new Error(`Missing backend descriptor field: ${name}`);
  }

  return value;
}

function parseBooleanField(value: string): boolean {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }

  throw new Error(`Invalid boolean backend descriptor value: ${value}`);
}

function stripYamlQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}
