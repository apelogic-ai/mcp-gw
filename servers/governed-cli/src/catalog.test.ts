import { describe, expect, test } from "bun:test";
import { CLI_DECISIONS_SCHEMA, parseCliDecisionCatalog } from "./catalog";

const FAKE_CATALOG = `
schemaVersion: ${CLI_DECISIONS_SCHEMA}
cli: fixture
commands:
  inspect:
    class: read
  change:
    class: write
  erase:
    class: destructive
`;

describe("CLI decisions catalog", () => {
  test("loads every declared command class", () => {
    const catalog = parseCliDecisionCatalog(FAKE_CATALOG);
    expect(catalog.cli).toBe("fixture");
    expect(catalog.commands).toEqual({
      inspect: { class: "read" },
      change: { class: "write" },
      erase: { class: "destructive" },
    });
  });

  test.each([
    FAKE_CATALOG.replace(CLI_DECISIONS_SCHEMA, "unknown/v1"),
    FAKE_CATALOG.replace("class: read", "class: observe"),
    `${FAKE_CATALOG}\nunknown: true`,
  ])("fails closed for an invalid catalog", (source) => {
    expect(() => parseCliDecisionCatalog(source)).toThrow();
  });

  test("makes a removed decision visible to the contract test", () => {
    const missing = FAKE_CATALOG.replace("  inspect:\n    class: read\n", "");
    expect(Object.keys(parseCliDecisionCatalog(missing).commands)).toEqual(["change", "erase"]);
  });
});
