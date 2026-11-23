import { randomUUID } from "node:crypto";

import type { GenericUpstreamCredential } from "./credentials";
import type { GenericGovernedTool, GenericWrapperDescriptor } from "./descriptor";
import { resolveAtlassianJiraSite } from "./oauth";

type JsonRpcId = string | number | null;
type JiraFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type JiraRequestLog = (line: string) => void;
const JIRA_ISSUE_KEY_OR_ID = /^(?:[A-Z][A-Z0-9_]{0,63}-[1-9][0-9]{0,17}|[1-9][0-9]{0,17})$/;
const JIRA_ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,63}-[1-9][0-9]{0,17}$/;
const JIRA_PROJECT_KEY = /^[A-Z][A-Z0-9_]{0,63}$/;
const JIRA_TRANSITION_ID = /^[1-9][0-9]{0,17}$/;
const JIRA_ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const JIRA_TEXT_LIMIT = 32_000;
const JIRA_SUMMARY_LIMIT = 255;

/** Catalogs whose tools this executor serves directly against Jira Cloud REST v3. */
export const JIRA_REST_CATALOG_IDS: ReadonlySet<string> = new Set([
  "jira-cloud-rest-v3-read-only",
  "jira-cloud-rest-v3-read-write",
]);

interface JiraRestCall {
  method: "GET" | "POST" | "PUT";
  url(base: string): URL;
  body?: Record<string, unknown>;
  result(body: unknown): Record<string, unknown>;
}

export interface JiraRestToolRequest {
  id: JsonRpcId;
  tool: GenericGovernedTool;
  arguments: Record<string, unknown>;
  credential: GenericUpstreamCredential;
}

export type JiraRestToolExecutor = (request: JiraRestToolRequest) => Promise<Response>;

export function createJiraRestToolExecutor(
  descriptor: GenericWrapperDescriptor,
  fetchImpl: JiraFetch = fetch,
  writeLog: JiraRequestLog = (line) => console.info(line),
): JiraRestToolExecutor {
  const credential = descriptor.credential;
  if (
    credential.mode !== "per_user_oauth" ||
    credential.providerId !== "jira" ||
    credential.identity.mode !== "atlassian_jira_asserted_email"
  ) {
    throw new Error("Jira REST tools require the bound Jira OAuth identity mode");
  }
  const jiraCredential = credential;
  const siteUrl = credential.identity.siteUrl;
  const browseBase = siteUrl.replace(/\/+$/, "");
  const timeoutMs = credential.timeoutMs ?? 5_000;
  return async (request) => {
    const target = jiraTarget(request.tool.upstreamName, request.arguments, request.id, browseBase);
    if (target instanceof Response) return target;
    const token = request.credential.rawValue;
    if (!token) throw new Error("Jira REST tools require a raw OAuth credential");
    const requestId = randomUUID();
    const startedAt = Date.now();
    let status: number | null = null;
    let errorClass = "transport_error";
    try {
      const resourceResponse = await providerResponse(
        fetchImpl,
        new URL(jiraCredential.userInfoUrl),
        token,
        timeoutMs,
      );
      status = resourceResponse.status;
      errorClass = jiraErrorClass(resourceResponse);
      if (!resourceResponse.ok) return sanitizedFailure(resourceResponse);
      errorClass = "site_resolution_error";
      const resources: unknown = await resourceResponse.json();
      const cloudId = resolveAtlassianJiraSite(resources, siteUrl);
      const base = `https://api.atlassian.com/ex/jira/${encodeURIComponent(cloudId)}/rest/api/3`;
      status = null;
      errorClass = "transport_error";
      const response = await providerResponse(
        fetchImpl,
        target.url(base),
        token,
        timeoutMs,
        target.method,
        target.body,
      );
      status = response.status;
      errorClass = jiraErrorClass(response);
      if (!response.ok) return sanitizedFailure(response);
      errorClass = "invalid_response";
      const body: unknown = response.status === 204 ? null : await response.json();
      const result = target.result(body);
      errorClass = "none";
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        },
      });
    } finally {
      emitJiraRequestLog(writeLog, {
        type: "mcp_gw_jira_upstream_request",
        tool: request.tool.exposedName,
        status,
        errorClass,
        durationMs: Math.max(0, Date.now() - startedAt),
        requestId,
      });
    }
  };
}

function jiraErrorClass(response: Response): string {
  if (response.ok) return "none";
  if (response.status === 401) return "provider_oauth_required";
  if (response.status === 403) return "provider_permission_denied";
  if (response.status === 429) return "provider_rate_limited";
  if (response.status >= 500) return "provider_unavailable";
  return "provider_rejected";
}

function emitJiraRequestLog(write: JiraRequestLog, event: Record<string, unknown>): void {
  try {
    write(JSON.stringify(event));
  } catch {
    // Logging must not change provider request handling.
  }
}

function jiraTarget(
  name: string,
  args: Record<string, unknown>,
  id: JsonRpcId,
  browseBase: string,
): JiraRestCall | Response {
  if (name === "getJiraCurrentUser" && exactKeys(args, [])) {
    return {
      method: "GET",
      url: (base) => new URL(`${base}/myself`),
      result: (body) => pick(record(body), ["accountId", "displayName", "emailAddress", "active"]),
    };
  }
  if (name === "searchJiraIssuesUsingJql" && exactKeys(args, ["jql", "maxResults"])) {
    const jql = boundedString(args.jql, 4_000);
    const maxResults = args.maxResults ?? 25;
    if (
      !jql ||
      typeof maxResults !== "number" ||
      !Number.isInteger(maxResults) ||
      maxResults < 1 ||
      maxResults > 50
    ) {
      return invalidArguments(id);
    }
    if (!jql.replace(/\border\s+by\b[\s\S]*$/i, "").trim()) {
      return toolError(id, "unbounded_jql", "JQL must include a search restriction");
    }
    return {
      method: "GET",
      url: (base) =>
        withSearch(new URL(`${base}/search/jql`), {
          jql,
          maxResults: String(maxResults),
          fields: "summary,status",
        }),
      result: (body) => {
        const issues = record(body).issues;
        return { issues: Array.isArray(issues) ? issues.map(trimIssue) : [] };
      },
    };
  }
  if (name === "getJiraIssue" && exactKeys(args, ["issueKey"])) {
    const issueKey = issueKeyArgument(args.issueKey);
    if (!issueKey) return invalidArguments(id);
    return {
      method: "GET",
      url: (base) =>
        withSearch(new URL(`${base}/issue/${encodeURIComponent(issueKey)}`), {
          fields: "summary,status",
        }),
      result: trimIssue,
    };
  }
  if (name === "listJiraIssueTransitions" && exactKeys(args, ["issueKey"])) {
    const issueKey = issueKeyArgument(args.issueKey);
    if (!issueKey) return invalidArguments(id);
    return {
      method: "GET",
      url: (base) => new URL(`${base}/issue/${encodeURIComponent(issueKey)}/transitions`),
      result: (body) => {
        const transitions = record(body).transitions;
        return {
          transitions: Array.isArray(transitions)
            ? transitions.map((value) => {
                const transition = record(value);
                return {
                  ...pick(transition, ["id", "name"]),
                  to: pick(record(transition.to), ["id", "name"]),
                };
              })
            : [],
        };
      },
    };
  }
  if (
    name === "createJiraIssue" &&
    exactKeys(args, ["projectKey", "issueType", "summary", "description"])
  ) {
    const projectKey = boundedString(args.projectKey, 64);
    const issueType = boundedString(args.issueType, 255);
    const summary = boundedString(args.summary, JIRA_SUMMARY_LIMIT);
    const description = optionalText(args.description);
    if (!projectKey || !JIRA_PROJECT_KEY.test(projectKey) || !issueType || !summary) {
      return invalidArguments(id);
    }
    if (description === null) return invalidArguments(id);
    return {
      method: "POST",
      url: (base) => new URL(`${base}/issue`),
      body: {
        fields: {
          project: { key: projectKey },
          issuetype: { name: issueType },
          summary,
          ...(description === undefined ? {} : { description: plainTextDocument(description) }),
        },
      },
      result: (body) => {
        const created = pick(record(body), ["id", "key"]);
        return typeof created.key === "string" && JIRA_ISSUE_KEY.test(created.key)
          ? { ...created, url: `${browseBase}/browse/${created.key}` }
          : created;
      },
    };
  }
  if (name === "addJiraIssueComment" && exactKeys(args, ["issueKey", "body"])) {
    const issueKey = issueKeyArgument(args.issueKey);
    const text = boundedString(args.body, JIRA_TEXT_LIMIT);
    if (!issueKey || !text) return invalidArguments(id);
    return {
      method: "POST",
      url: (base) => new URL(`${base}/issue/${encodeURIComponent(issueKey)}/comment`),
      body: { body: plainTextDocument(text) },
      result: (body) => {
        const commentId = record(body).id;
        return { issueKey, ...(commentId === undefined ? {} : { commentId }) };
      },
    };
  }
  if (name === "transitionJiraIssue" && exactKeys(args, ["issueKey", "transitionId"])) {
    const issueKey = issueKeyArgument(args.issueKey);
    const transitionId = args.transitionId;
    if (!issueKey || typeof transitionId !== "string" || !JIRA_TRANSITION_ID.test(transitionId)) {
      return invalidArguments(id);
    }
    return {
      method: "POST",
      url: (base) => new URL(`${base}/issue/${encodeURIComponent(issueKey)}/transitions`),
      body: { transition: { id: transitionId } },
      result: () => ({ issueKey, transitionId }),
    };
  }
  if (name === "editJiraIssue" && exactKeys(args, ["issueKey", "summary", "description"])) {
    const issueKey = issueKeyArgument(args.issueKey);
    const summary =
      args.summary === undefined ? undefined : boundedString(args.summary, JIRA_SUMMARY_LIMIT);
    const description = optionalText(args.description);
    const invalidSummary = args.summary !== undefined && summary === undefined;
    if (!issueKey || invalidSummary || description === null) {
      return invalidArguments(id);
    }
    const fields: Record<string, unknown> = {};
    if (summary !== undefined) fields.summary = summary;
    if (description !== undefined) fields.description = plainTextDocument(description);
    const updatedFields = Object.keys(fields);
    if (updatedFields.length === 0) return invalidArguments(id);
    return {
      method: "PUT",
      url: (base) => new URL(`${base}/issue/${encodeURIComponent(issueKey)}`),
      body: { fields },
      result: () => ({ issueKey, updatedFields }),
    };
  }
  if (name === "assignJiraIssue" && exactKeys(args, ["issueKey", "accountId"])) {
    const issueKey = issueKeyArgument(args.issueKey);
    const accountId = args.accountId;
    if (
      !issueKey ||
      !(accountId === null || (typeof accountId === "string" && JIRA_ACCOUNT_ID.test(accountId)))
    ) {
      return invalidArguments(id);
    }
    return {
      method: "PUT",
      url: (base) => new URL(`${base}/issue/${encodeURIComponent(issueKey)}/assignee`),
      body: { accountId },
      result: () => ({ issueKey, accountId }),
    };
  }
  return invalidArguments(id);
}

function issueKeyArgument(value: unknown): string | undefined {
  const issueKey = boundedString(value, 128);
  return issueKey && JIRA_ISSUE_KEY_OR_ID.test(issueKey) ? issueKey : undefined;
}

/** undefined when absent, null when present but invalid. */
function optionalText(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "string" && value.length <= JIRA_TEXT_LIMIT ? value : null;
}

/** Jira Cloud REST v3 takes rich text as an Atlassian document; each line is one paragraph. */
function plainTextDocument(text: string): Record<string, unknown> {
  return {
    type: "doc",
    version: 1,
    content: text
      .split(/\r?\n/)
      .map((line) =>
        line
          ? { type: "paragraph", content: [{ type: "text", text: line }] }
          : { type: "paragraph" },
      ),
  };
}

function withSearch(url: URL, values: Record<string, string>): URL {
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
  return url;
}

function providerResponse(
  fetchImpl: JiraFetch,
  url: URL,
  token: string,
  timeoutMs: number,
  method: JiraRestCall["method"] = "GET",
  body?: Record<string, unknown>,
): Promise<Response> {
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${token}`,
  };
  if (body) headers["content-type"] = "application/json";
  return fetchImpl(url, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
}

function sanitizedFailure(response: Response): Response {
  const headers = new Headers();
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) headers.set("retry-after", retryAfter);
  return new Response(null, { status: response.status, headers });
}

function trimIssue(value: unknown): Record<string, unknown> {
  const issue = record(value);
  const fields = record(issue.fields);
  return {
    ...pick(issue, ["id", "key"]),
    fields: {
      ...pick(fields, ["summary"]),
      status: pick(record(fields.status), ["id", "name"]),
    },
  };
}

function pick(value: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(
    keys.flatMap((key) => (value[key] === undefined ? [] : [[key, value[key]]])),
  );
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max
    ? value
    : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function invalidArguments(id: JsonRpcId): Response {
  return toolError(id, "invalid_arguments", "Invalid tool arguments");
}

function toolError(id: JsonRpcId, error: string, message: string): Response {
  return Response.json({
    jsonrpc: "2.0",
    id,
    result: {
      isError: true,
      content: [{ type: "text", text: message }],
      structuredContent: { error },
    },
  });
}
