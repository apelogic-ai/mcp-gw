import { describe, expect, test } from "bun:test";

import { projectMetadata } from "./project";

describe("project metadata", () => {
  test("identifies the gateway project", () => {
    expect(projectMetadata).toEqual({
      name: "mcp-gateway",
      stack: "bun-typescript",
      agentAgnostic: true,
    });
  });
});
