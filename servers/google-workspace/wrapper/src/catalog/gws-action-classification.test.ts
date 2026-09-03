import { describe, expect, test } from "bun:test";

import {
  classifyGwsDiscoveryMethod,
  GWS_ACTION_CLASSIFICATION_ID,
  GWS_DESTRUCTIVE_METHOD_OVERRIDES,
} from "./gws-action-classification";

const EXPECTED_DESTRUCTIVE_OVERRIDES = [
  "calendar:calendars.clear",
  "calendar:calendars.transferOwnership",
  "calendar:channels.stop",
  "docs:documents.batchUpdate",
  "drive:accessproposals.resolve",
  "drive:approvals.cancel",
  "drive:approvals.decline",
  "drive:channels.stop",
  "gmail:users.messages.batchDelete",
  "gmail:users.messages.trash",
  "gmail:users.settings.cse.keypairs.disable",
  "gmail:users.settings.cse.keypairs.obliterate",
  "gmail:users.stop",
  "gmail:users.threads.trash",
  "meet:spaces.endActiveConference",
  "sheets:spreadsheets.batchUpdate",
  "sheets:spreadsheets.values.batchClear",
  "sheets:spreadsheets.values.batchClearByDataFilter",
  "sheets:spreadsheets.values.clear",
  "slides:presentations.batchUpdate",
  "tasks:tasks.clear",
] as const;

describe("Google Workspace generated action classification", () => {
  test("pins the reviewed semantic override contract", () => {
    expect(GWS_ACTION_CLASSIFICATION_ID).toBe("google-workspace-cli@0.22.5/actions-v1");
    expect(Object.keys(GWS_DESTRUCTIVE_METHOD_OVERRIDES).sort()).toEqual(
      [...EXPECTED_DESTRUCTIVE_OVERRIDES].sort(),
    );
  });

  test("classifies every reviewed non-DELETE method as destructive", () => {
    for (const key of EXPECTED_DESTRUCTIVE_OVERRIDES) {
      const [alias, path] = key.split(":");

      expect(classifyGwsDiscoveryMethod(alias ?? "", path?.split(".") ?? [], "POST")).toBe(
        "destructive",
      );
    }
  });

  test("retains deterministic transport defaults outside reviewed overrides", () => {
    expect(classifyGwsDiscoveryMethod("drive", ["files", "get"], "GET")).toBe("read");
    expect(classifyGwsDiscoveryMethod("drive", ["files", "delete"], "DELETE")).toBe("destructive");
    expect(classifyGwsDiscoveryMethod("drive", ["files", "update"], "PATCH")).toBe("write");
  });
});
