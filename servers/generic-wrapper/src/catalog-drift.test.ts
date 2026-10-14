import { describe, expect, test } from "bun:test";

import { compareCatalogDecisions } from "./catalog-drift";
import { parseGenericToolDecisions } from "./descriptor";

describe("generic live catalog drift", () => {
  test("reports new upstream tools and removed decided tools without storing metadata", () => {
    const decisions = parseGenericToolDecisions(
      {
        schemaVersion: "mcp-gateway.generic-tool-decisions/v1",
        catalogId: "fixture-live",
        tools: [
          {
            name: "present",
            disposition: "include",
            alias: "present",
            actionClass: "read",
            operation: "fixture.present.get",
            scopes: [],
          },
          { name: "removed", disposition: "exclude", reason: "unsupported" },
        ],
      },
      "fixture",
    );

    expect(
      compareCatalogDecisions(decisions.decisions, [
        { name: "present", description: "Present", inputSchema: { type: "object" } },
        { name: "newTool", description: "New", inputSchema: { type: "object" } },
      ]),
    ).toEqual({ withoutDecision: ["newTool"], missingUpstream: ["removed"] });
  });
});
