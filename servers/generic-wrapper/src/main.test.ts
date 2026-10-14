import { describe, expect, test } from "bun:test";

import { loadGenericMainConfig } from "./main";

describe("generic wrapper runtime configuration", () => {
  test("requires only a descriptor path and port for non-OAuth wrappers", () => {
    expect(
      loadGenericMainConfig({
        GENERIC_WRAPPER_DESCRIPTOR_PATH: "/etc/mcp-gw/descriptor.yaml",
      }),
    ).toEqual({
      port: 8080,
      descriptorPath: "/etc/mcp-gw/descriptor.yaml",
      taskToolAuthorization: { allowLegacyUnscopedTaskTokens: false },
    });
  });

  test("loads only the explicit legacy Task-token compatibility opt-out", () => {
    expect(
      loadGenericMainConfig({
        GENERIC_WRAPPER_DESCRIPTOR_PATH: "/etc/mcp-gw/descriptor.yaml",
        MCP_GW_ALLOW_LEGACY_UNSCOPED_TASK_TOKENS: "true",
      }).taskToolAuthorization,
    ).toEqual({ allowLegacyUnscopedTaskTokens: true });
    expect(() =>
      loadGenericMainConfig({
        GENERIC_WRAPPER_DESCRIPTOR_PATH: "/etc/mcp-gw/descriptor.yaml",
        MCP_GW_ALLOW_LEGACY_UNSCOPED_TASK_TOKENS: "1",
      }),
    ).toThrow("MCP_GW_ALLOW_LEGACY_UNSCOPED_TASK_TOKENS must be true or false");
  });

  test("rejects a relative descriptor path and invalid port", () => {
    expect(() =>
      loadGenericMainConfig({ GENERIC_WRAPPER_DESCRIPTOR_PATH: "descriptor.yaml" }),
    ).toThrow("absolute");
    expect(() =>
      loadGenericMainConfig({
        GENERIC_WRAPPER_DESCRIPTOR_PATH: "/etc/mcp-gw/descriptor.yaml",
        PORT: "70000",
      }),
    ).toThrow("PORT");
  });
});
