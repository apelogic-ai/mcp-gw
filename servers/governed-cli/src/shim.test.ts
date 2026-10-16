import { describe, expect, test } from "bun:test";
import { runCliShim } from "./shim";

function writer(values: string[]) {
  return { write: (data: string) => values.push(data) };
}

describe("governed CLI shim", () => {
  test("forwards streamed output live and exits with the remote code", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const encoder = new TextEncoder();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const requests: { url: string; authorization: string | null; body: unknown }[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        value.enqueue(encoder.encode('{"type":"stdout","data":"first\\n"}\n'));
      },
    });
    const running = runCliShim({
      cli: "fixture",
      args: ["inspect", ";", "|", "$(x)"],
      endpoint: "https://cli.example.com/cli/run",
      token: "run-token",
      stdout: writer(stdout),
      stderr: writer(stderr),
      fetch: (input, init) => {
        requests.push({
          url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
          authorization: new Headers(init?.headers).get("authorization"),
          body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
        });
        return Promise.resolve(new Response(stream));
      },
    });

    await Bun.sleep(0);
    expect(stdout).toEqual(["first\n"]);
    controller?.enqueue(encoder.encode('{"type":"stderr","data":"warn\\n"}\n'));
    controller?.enqueue(encoder.encode('{"type":"exit","exit_code":9,"truncated":false}\n'));
    controller?.close();

    expect(await running).toBe(9);
    expect(stderr).toEqual(["warn\n"]);
    expect(requests).toEqual([
      {
        url: "https://cli.example.com/cli/run",
        authorization: "Bearer run-token",
        body: { cli: "fixture", args: ["inspect", ";", "|", "$(x)"] },
      },
    ]);
  });

  test("reports HTTP and protocol failures without echoing response bodies", async () => {
    for (const response of [
      new Response('{"error":"provider-secret"}', { status: 403 }),
      new Response('{"type":"stdout","data":"missing exit"}\n'),
    ]) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      expect(
        await runCliShim({
          cli: "fixture",
          args: ["inspect"],
          endpoint: "https://cli.example.com/cli/run",
          token: "run-token",
          stdout: writer(stdout),
          stderr: writer(stderr),
          fetch: () => Promise.resolve(response),
        }),
      ).toBe(1);
      expect(stdout).toEqual(response.status === 403 ? [] : ["missing exit"]);
      expect(stderr.join("")).toBe("CLI request failed\n");
      expect(stderr.join("")).not.toContain("provider-secret");
    }
  });
});
