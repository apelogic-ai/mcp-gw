import { describe, expect, test } from "bun:test";

import { JsonLineConnectionLifecycleMetricSink } from "./connection-metrics";

describe("connection diagnostic event sink", () => {
  test("serializes only bounded fields, even if an event carries arbitrary extras", () => {
    const lines: string[] = [];
    const sink = new JsonLineConnectionLifecycleMetricSink((line) => lines.push(line));
    sink.record({
      name: "renewal_outcome",
      provider: "google",
      operation: "automatic",
      outcome: "failure",
      category: "transient_provider_failure",
      value: 1,
      diagnosticId: "d62b3f8b-337a-41a4-837c-a1a24c71c897",
      token: "secret-token",
      email: "user@example.com",
      body: "raw MIME",
    } as Parameters<typeof sink.record>[0]);

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toEqual({
      type: "mcp_gw_connection_diagnostic",
      name: "renewal_outcome",
      provider: "google",
      operation: "automatic",
      outcome: "failure",
      category: "transient_provider_failure",
      value: 1,
      diagnosticId: "d62b3f8b-337a-41a4-837c-a1a24c71c897",
    });
    expect(lines[0]).not.toContain("secret-token");
    expect(lines[0]).not.toContain("user@example.com");
    expect(lines[0]).not.toContain("raw MIME");
  });
});
