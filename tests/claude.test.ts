import { describe, expect, it } from "vitest";
import { createClaudeClient } from "../src/services/llm/claude.js";
import { claudeCost } from "../src/services/llm/claudePrices.js";
import { usageUsd } from "../src/services/llm/usage.js";
import { GrokError, toUserMessage } from "../src/utils/errors.js";

const KEY = "sk-ant-test-secret";
const SCHEMA = { type: "object", additionalProperties: false, required: ["a"], properties: { a: { type: "number" } } };

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, any>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function sseResponse(events: Array<[string, unknown]>, chunkSize = 23): Response {
  const text = events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < bytes.length; at += chunkSize) controller.enqueue(bytes.slice(at, at + chunkSize));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function setup(responses: Array<() => Response>) {
  const calls: Call[] = [];
  const fake = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    return next!();
  }) as unknown as typeof fetch;
  const client = createClaudeClient({
    apiKey: KEY,
    model: "claude-sonnet-5-5",
    timeoutMs: 5_000,
    maxOutputTokens: 512,
    fetch: fake,
    sleep: async () => undefined,
  });
  return { client, calls };
}

const textAnswer = (text: string) => () =>
  jsonResponse({ content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 3 } });

const streamEvents = (deltas: Array<Record<string, unknown>>, stopReason = "end_turn"): Array<[string, unknown]> => [
  ["message_start", { type: "message_start", message: { usage: { input_tokens: 20, output_tokens: 1 } } }],
  ["ping", { type: "ping" }],
  ...deltas.map((delta): [string, unknown] => [
    "content_block_delta",
    { type: "content_block_delta", index: 0, delta },
  ]),
  ["message_delta", { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 5 } }],
  ["message_stop", { type: "message_stop" }],
];

describe("claude adapter", () => {
  it("sends a Messages request and labels the result with model and cost", async () => {
    const { client, calls } = setup([textAnswer("Hello")]);
    const result = await client.completeText({ system: "Be brief.", user: "Hi" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0]!.headers["x-api-key"]).toBe(KEY);
    expect(calls[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(calls[0]!.body.model).toBe("claude-sonnet-5-5");
    expect(calls[0]!.body.max_tokens).toBe(512);
    expect(calls[0]!.body.system).toBe("Be brief.");
    expect(calls[0]!.body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "Hi" }] }]);
    expect(calls[0]!.body.tools).toBe(undefined);
    expect(result.text).toBe("Hello");
    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(3);
    expect(result.model).toBe("claude-sonnet-5-5");
    expect(result.estimatedUsd).toBeCloseTo(0.00005, 8);
  });

  it("returns structured output through a forced tool call", async () => {
    const { client, calls } = setup([
      () =>
        jsonResponse({
          content: [{ type: "tool_use", id: "t1", name: "copilot_intent", input: { a: 1 } }],
          stop_reason: "tool_use",
          usage: { input_tokens: 40, output_tokens: 8 },
        }),
    ]);
    const result = await client.completeStructured({ system: "S", user: "U", schemaName: "copilot_intent", schema: SCHEMA });
    expect(calls[0]!.body.tool_choice).toEqual({ type: "tool", name: "copilot_intent" });
    expect(calls[0]!.body.tools[0].input_schema).toEqual(SCHEMA);
    expect(result.text).toBe('{"a":1}');
  });

  it("sends images before the text and ignores a model name from another provider", async () => {
    const { client, calls } = setup([
      () => jsonResponse({ content: [{ type: "tool_use", id: "t1", name: "doc", input: { a: 1 } }], stop_reason: "tool_use", usage: { input_tokens: 5, output_tokens: 2 } }),
    ]);
    await client.completeStructured({
      system: "S",
      user: "Describe",
      schemaName: "doc",
      schema: SCHEMA,
      images: [{ mime: "image/png", base64: "AAAA" }],
      model: "grok-4.20",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.model).toBe("claude-sonnet-5-5");
    expect(calls[0]!.body.messages[0].content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "text", text: "Describe" },
    ]);
  });

  it("retries an overloaded response once", async () => {
    const { client, calls } = setup([
      () => jsonResponse({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, 529),
      textAnswer("second try"),
    ]);
    const result = await client.completeText({ system: "S", user: "U" });
    expect(calls).toHaveLength(2);
    expect(result.text).toBe("second try");
  });

  it("does not retry a bad request and never echoes the API key", async () => {
    const { client, calls } = setup([
      () => jsonResponse({ type: "error", error: { type: "invalid_request_error", message: "credit balance is too low" } }, 400),
    ]);
    let error: unknown;
    try {
      await client.completeText({ system: "S", user: "U" });
    } catch (caught) {
      error = caught;
    }
    expect(calls).toHaveLength(1);
    expect(error).toBeInstanceOf(GrokError);
    const grok = error as GrokError;
    expect(grok.provider).toBe("claude");
    expect(grok.status).toBe(400);
    expect(grok.retryable).toBe(false);
    expect(grok.message).toContain("credit balance is too low");
    expect(grok.message).not.toContain(KEY);
    expect(toUserMessage(grok)).toContain("Claude");
  });

  it("fails without retrying when the answer hits the output limit", async () => {
    const { client, calls } = setup([
      () => jsonResponse({ content: [{ type: "text", text: "partial" }], stop_reason: "max_tokens", usage: { input_tokens: 5, output_tokens: 512 } }),
    ]);
    let error: unknown;
    try {
      await client.completeText({ system: "S", user: "U" });
    } catch (caught) {
      error = caught;
    }
    expect(calls).toHaveLength(1);
    expect((error as GrokError).retryable).toBe(false);
  });

  it("refuses web search and tools without calling the API", async () => {
    const { client, calls } = setup([textAnswer("never")]);
    let error: unknown;
    try {
      await client.completeText({ system: "S", user: "U", webSearch: true });
    } catch (caught) {
      error = caught;
    }
    expect(calls).toHaveLength(0);
    expect(error).toBeInstanceOf(GrokError);
    expect((error as GrokError).retryable).toBe(false);
  });

  it("streams text across chunk boundaries and reports usage", async () => {
    const { client, calls } = setup([
      () => sseResponse(streamEvents([{ type: "text_delta", text: "Hel" }, { type: "text_delta", text: "lo" }])),
    ]);
    const snapshots: string[] = [];
    const result = await client.streamText!({ system: "S", user: "U", onDelta: (text) => void snapshots.push(text) });
    expect(calls[0]!.body.stream).toBe(true);
    expect(result.text).toBe("Hello");
    expect(snapshots[snapshots.length - 1]).toBe("Hello");
    expect(result.inputTokens).toBe(20);
    expect(result.outputTokens).toBe(5);
    expect(result.model).toBe("claude-sonnet-5-5");
  });

  it("streams structured output as partial JSON", async () => {
    const { client } = setup([
      () => sseResponse(streamEvents([{ type: "input_json_delta", partial_json: '{"a":' }, { type: "input_json_delta", partial_json: "1}" }])),
    ]);
    const result = await client.streamStructured!({ system: "S", user: "U", schemaName: "doc", schema: SCHEMA });
    expect(result.text).toBe('{"a":1}');
  });

  it("does not retry a stream that stopped at the output limit", async () => {
    const { client, calls } = setup([
      () => sseResponse(streamEvents([{ type: "text_delta", text: "cut" }], "max_tokens")),
    ]);
    let error: unknown;
    try {
      await client.streamText!({ system: "S", user: "U" });
    } catch (caught) {
      error = caught;
    }
    expect(calls).toHaveLength(1);
    expect((error as GrokError).retryable).toBe(false);
  });

  it("retries a stream that fails with an overloaded error event", async () => {
    const { client, calls } = setup([
      () => sseResponse([["error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }]]),
      () => sseResponse(streamEvents([{ type: "text_delta", text: "fine" }])),
    ]);
    const result = await client.streamText!({ system: "S", user: "U" });
    expect(calls).toHaveLength(2);
    expect(result.text).toBe("fine");
  });
});

describe("claude prices and usage cost", () => {
  it("prices Sonnet flat and Haiku by prompt size", () => {
    expect(claudeCost("claude-sonnet-5-5", 1_000_000, 1_000_000)).toBeCloseTo(12, 6);
    expect(claudeCost("claude-haiku-5-5", 100_000, 10_000)).toBeCloseTo(0.015, 6);
    expect(claudeCost("claude-haiku-5-5", 200_000, 10_000)).toBeCloseTo(0.125, 6);
    expect(claudeCost("claude-unknown", 1, 1)).toBe(null);
  });

  it("prices xAI results with env rates and Claude results with their own cost", () => {
    const rates = { XAI_INPUT_USD_PER_MILLION: 2, XAI_OUTPUT_USD_PER_MILLION: 6 };
    expect(usageUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, rates)).toBeCloseTo(8, 6);
    expect(usageUsd({ inputTokens: 1, outputTokens: 1, model: "claude-sonnet-5-5", estimatedUsd: 0.5 }, rates)).toBe(0.5);
    expect(usageUsd({ inputTokens: 1_000_000, outputTokens: 0, model: "claude-unknown" }, rates)).toBe(0);
  });
});
