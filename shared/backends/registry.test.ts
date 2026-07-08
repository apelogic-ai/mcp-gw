import { describe, expect, test } from "bun:test";

import {
  parseBackendDescriptor,
  renderAgentgatewayConfig,
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

  test("renders enabled agentgateway targets from descriptors", () => {
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
        enabledByDefault: false,
      },
    ]);

    expect(rendered).toContain("- name: google-workspace");
    expect(rendered).toContain("host: http://google-workspace:8080/mcp");
    expect(rendered).not.toContain("- name: db-mcp");
  });

  test("renders optional agentgateway targets when requested", () => {
    const rendered = renderAgentgatewayTargets(
      [
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
          enabledByDefault: false,
        },
      ],
      { includeOptional: true },
    );

    expect(rendered).toContain("- name: db-mcp");
    expect(rendered).toContain("host: http://db-mcp:8080/mcp");
    expect(rendered).toContain("backendAuth:");
    expect(rendered).toContain("passthrough: {}");
  });

  test("renders full agentgateway configs with the shared route policy", () => {
    const rendered = renderAgentgatewayConfig([
      {
        name: "google-workspace",
        host: "http://google-workspace:8080/mcp",
        toolPrefix: "google",
        enabledByDefault: true,
      },
    ]);

    expect(rendered).toContain("binds:");
    expect(rendered).toContain("exact: /mcp");
    expect(rendered).toContain("exact: /.well-known/oauth-protected-resource/mcp");
    expect(rendered).toContain("allowHeaders: [mcp-protocol-version, content-type, authorization]");
    expect(rendered).toContain("targets:");
    expect(rendered).toContain("name: google-workspace");
  });
});
