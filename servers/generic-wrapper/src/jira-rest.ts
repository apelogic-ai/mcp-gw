import type { GenericUpstreamCredential } from "./credentials";
import type { GenericGovernedTool, GenericWrapperDescriptor } from "./descriptor";
import { resolveAtlassianJiraSite } from "./oauth";

type JsonRpcId = string | number | null;
type JiraFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const JIRA_ISSUE_KEY_OR_ID = /^(?:[A-Z][A-Z0-9_]{0,63}-[1-9][0-9]{0,17}|[1-9][0-9]{0,17})$/;

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
  const timeoutMs = credential.timeoutMs ?? 5_000;
  return async (request) => {
    const target = jiraTarget(request.tool.upstreamName, request.arguments, request.id);
    if (target instanceof Response) return target;
    const token = request.credential.rawValue;
    if (!token) throw new Error("Jira REST tools require a raw OAuth credential");
    const resourceResponse = await providerResponse(
      fetchImpl,
      new URL(jiraCredential.userInfoUrl),
      token,
      timeoutMs,
    );
    if (!resourceResponse.ok) return sanitizedFailure(resourceResponse);
    const resources: unknown = await resourceResponse.json();
    const cloudId = resolveAtlassianJiraSite(resources, siteUrl);
    const base = `https://api.atlassian.com/ex/jira/${encodeURIComponent(cloudId)}/rest/api/3`;
    const response = await providerResponse(fetchImpl, target(base), token, timeoutMs);
    if (!response.ok) return sanitizedFailure(response);
    const body = await response.json();
    const result = trimResult(request.tool.upstreamName, body);
    return Response.json({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      },
    });
  };
}

function jiraTarget(
  name: string,
  args: Record<string, unknown>,
  id: JsonRpcId,
): ((base: string) => URL) | Response {
  if (name === "getJiraCurrentUser" && exactKeys(args, [])) {
    return (base) => new URL(`${base}/myself`);
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
    return (base) =>
      withSearch(new URL(`${base}/search/jql`), {
        jql,
        maxResults: String(maxResults),
        fields: "summary,status",
      });
  }
  if (name === "getJiraIssue" && exactKeys(args, ["issueKey"])) {
    const issueKey = boundedString(args.issueKey, 128);
    if (!issueKey || !JIRA_ISSUE_KEY_OR_ID.test(issueKey)) return invalidArguments(id);
    return (base) =>
      withSearch(new URL(`${base}/issue/${encodeURIComponent(issueKey)}`), {
        fields: "summary,status",
      });
  }
  return invalidArguments(id);
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
): Promise<Response> {
  return fetchImpl(url, {
    headers: { accept: "application/json", authorization: `Bearer ${token}` },
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

function trimResult(name: string, value: unknown): Record<string, unknown> {
  const body = record(value);
  if (name === "getJiraCurrentUser") {
    return pick(body, ["accountId", "displayName", "emailAddress", "active"]);
  }
  if (name === "searchJiraIssuesUsingJql") {
    const issues = Array.isArray(body.issues) ? body.issues.map(trimIssue) : [];
    return { issues };
  }
  return trimIssue(body);
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
