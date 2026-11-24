import { expect } from "bun:test";

interface ToolErrorBody {
  result: {
    isError?: boolean;
    content?: { text?: string }[];
    structuredContent?: Record<string, unknown>;
  };
}

// A tool error carries its text in content and in structuredContent.message:
// some MCP clients show the model only structuredContent when it is present.
export async function toolErrorBody(response: Response): Promise<unknown> {
  const body = (await response.json()) as ToolErrorBody;
  const text = body.result.content?.[0]?.text;
  expect(body.result.isError).toBe(true);
  expect(text).toBeTruthy();
  expect(body.result.structuredContent?.message).toBe(text);
  return body;
}
