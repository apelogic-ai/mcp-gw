import { describe, expect, test } from "bun:test";

import {
  parseBackendDescriptor,
  renderAgentgatewayTargets,
  validateBackendRegistry,
} from "./registry";

describe("MCP backend registry", () => {
  test("parses a public backend descriptor", () => {
    const descriptor = parseBackendDescriptor(`
name: google-workspace
host: http://google-workspace:8080/mcp
toolPrefix: google
enabledByDefault: true
`);

    expect(descriptor).toEqual({
      name: "google-workspace",
      host: "http://google-workspace:8080/mcp",
      toolPrefix: "google",
      enabledByDefault: true,
    });
  });

  test("defaults descriptors to enabled when the field is omitted", () => {
    const descriptor = parseBackendDescriptor(`
name: db-mcp
host: http://db-mcp:8080/mcp
toolPrefix: db
`);

    expect(descriptor.enabledByDefault).toBe(true);
  });

  test("rejects duplicate backend names and tool prefixes", () => {
    const google = parseBackendDescriptor(`
name: google-workspace
host: http://google-workspace:8080/mcp
toolPrefix: google
`);
    const duplicateName = parseBackendDescriptor(`
name: google-workspace
host: http://google-workspace-v2:8080/mcp
toolPrefix: google2
`);
    const duplicatePrefix = parseBackendDescriptor(`
name: drive
host: http://drive:8080/mcp
toolPrefix: google
`);

    expect(() => validateBackendRegistry([google, duplicateName])).toThrow(
      "Duplicate backend name",
    );
    expect(() => validateBackendRegistry([google, duplicatePrefix])).toThrow(
      "Duplicate backend tool prefix",
    );
  });

  test("renders agentgateway target config from descriptors", () => {
    const rendered = renderAgentgatewayTargets([
      {
        name: "google-workspace",
        host: "http://google-workspace:8080/mcp",
        toolPrefix: "google",
        enabledByDefault: true,
      },
      {
        name: "db-mcp",
        host: "http://db-mcp:8080/mcp",
        toolPrefix: "db",
        enabledByDefault: true,
      },
    ]);

    expect(rendered).toContain("- name: google-workspace");
    expect(rendered).toContain("host: http://google-workspace:8080/mcp");
    expect(rendered).toContain("- name: db-mcp");
    expect(rendered).toContain("host: http://db-mcp:8080/mcp");
    expect(rendered).toContain("backendAuth:");
    expect(rendered).toContain("passthrough: {}");
  });
});
