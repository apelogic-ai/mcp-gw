import { describe, expect, test } from "bun:test";

import { loadGenericMainConfig } from "./main";

describe("generic wrapper runtime configuration", () => {
  test("requires only a descriptor path and port for non-OAuth wrappers", () => {
    expect(
      loadGenericMainConfig({
        GENERIC_WRAPPER_DESCRIPTOR_PATH: "/etc/mcp-gw/descriptor.yaml",
      }),
    ).toEqual({ port: 8080, descriptorPath: "/etc/mcp-gw/descriptor.yaml" });
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
