import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("Google Workspace MCP skill bundle", () => {
  test("ships an agent skill for using the generated gws MCP tools", () => {
    const skill = readFileSync("servers/google-workspace/skills/gws-mcp/SKILL.md", "utf8");

    expect(skill).toContain("name: gws-mcp");
    expect(skill).toContain("gws_<service>_<resource>_<method>");
    expect(skill).toContain("google_workspace_gws");
    expect(skill).toContain("params");
    expect(skill).toContain("json");
    expect(skill).toContain("uploadBase64");
    expect(skill).toContain("server filesystem");
    expect(skill).toContain("args");
    expect(skill).toContain("reconnect");
  });

  test("ships gws MCP recipe reference material", () => {
    const reference = readFileSync(
      "servers/google-workspace/skills/gws-mcp/references/tool-patterns.md",
      "utf8",
    );

    expect(reference).toContain("Template-based Slides Deck");
    expect(reference).toContain("gws_drive_files_copy");
    expect(reference).toContain("gws_slides_presentations_batch_update");
    expect(reference).toContain("objectId");
    expect(reference).toContain("at least 5 characters");
    expect(reference).toContain("slide_005");
    expect(reference).toContain("API disabled");
    expect(reference).toContain("missing scope");
    expect(reference).toContain("Inline Drive Upload");
    expect(reference).toContain("uploadBase64");
  });
});
