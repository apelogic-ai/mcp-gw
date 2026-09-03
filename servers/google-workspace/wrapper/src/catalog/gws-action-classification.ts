export type GwsActionClass = "read" | "write" | "destructive";

/**
 * Versioned semantic classification layered over Google Discovery HTTP methods.
 *
 * Discovery identifies transport semantics, not governance semantics. In particular,
 * several POST operations delete content, revoke authority, terminate live activity,
 * or accept arbitrary batch mutations that can delete content. Keep those exceptions
 * explicit and reviewed here; generated catalog output must never be edited by hand.
 */
export const GWS_ACTION_CLASSIFICATION_ID = "google-workspace-cli@0.22.5/actions-v1" as const;

export const GWS_DESTRUCTIVE_METHOD_OVERRIDES = {
  "calendar:calendars.clear": "deletes every event on a primary calendar",
  "calendar:calendars.transferOwnership": "transfers ownership away from the caller",
  "calendar:channels.stop": "revokes a notification channel",
  "docs:documents.batchUpdate": "accepts delete-content batch requests",
  "drive:accessproposals.resolve": "can deny and close an access proposal",
  "drive:approvals.cancel": "cancels and closes an approval",
  "drive:approvals.decline": "declines and closes an approval",
  "drive:channels.stop": "revokes a notification channel",
  "gmail:users.messages.batchDelete": "permanently deletes multiple messages",
  "gmail:users.messages.trash": "removes a message from the active mailbox",
  "gmail:users.settings.cse.keypairs.disable": "revokes use of an encryption key pair",
  "gmail:users.settings.cse.keypairs.obliterate":
    "permanently destroys an encryption key pair and access to encrypted mail",
  "gmail:users.stop": "revokes mailbox push notifications",
  "gmail:users.threads.trash": "removes a thread from the active mailbox",
  "meet:spaces.endActiveConference": "terminates a live conference",
  "sheets:spreadsheets.batchUpdate": "accepts delete-content batch requests",
  "sheets:spreadsheets.values.batchClear": "deletes values from multiple ranges",
  "sheets:spreadsheets.values.batchClearByDataFilter": "deletes values selected by data filters",
  "sheets:spreadsheets.values.clear": "deletes values from a range",
  "slides:presentations.batchUpdate": "accepts delete-content batch requests",
  "tasks:tasks.clear": "removes completed tasks from the visible task list",
} as const satisfies Readonly<Record<string, string>>;

export function classifyGwsDiscoveryMethod(
  alias: string,
  path: readonly string[],
  httpMethod: string,
): GwsActionClass {
  const key = `${alias}:${path.join(".")}`;
  if (key in GWS_DESTRUCTIVE_METHOD_OVERRIDES) {
    return "destructive";
  }

  if (httpMethod === "GET") {
    return "read";
  }

  if (httpMethod === "DELETE") {
    return "destructive";
  }

  return "write";
}

export function classifyGovernedGwsToolAction(
  alias: string,
  commandPath: string,
  legacyActionClass: GwsActionClass,
): GwsActionClass {
  const key = `${alias}:${commandPath}`;
  return key in GWS_DESTRUCTIVE_METHOD_OVERRIDES ? "destructive" : legacyActionClass;
}
