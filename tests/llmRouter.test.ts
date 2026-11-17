import { describe, expect, it } from "vitest";
import type { LlmClient, LlmResult } from "../src/services/grok/client.js";
import { createRoutedClient, type FallbackInfo } from "../src/services/llm/router.js";
import type { ClaudeTask } from "../src/services/llm/tasks.js";
import { GrokError } from "../src/utils/errors.js";

type Log = string[];

function fake(name: string, log: Log, failWith?: GrokError): LlmClient {
  const result = (): LlmResult => ({ text: name, inputTokens: 1, outputTokens: 1 });
  const hit = async (method: string): Promise<LlmResult> => {
    log.push(`${name}.${method}`);
    if (failWith) throw failWith;
    return result();
  };
  return {
    completeStructured: () => hit("completeStructured"),
    completeText: () => hit("completeText"),
    streamStructured: () => hit("streamStructured"),
    streamText: () => hit("streamText"),
    completeWithTools: async () => {
      log.push(`${name}.completeWithTools`);
      if (failWith) throw failWith;
      return { ...result(), functionCalls: [] };
    },
    embed: async () => {
      log.push(`${name}.embed`);
      return { vectors: [[0]], inputTokens: 1 };
    },
  };
}

function build(options: {
  tasks: ClaudeTask[];
  fallback?: boolean;
  claudeFails?: GrokError;
  xaiFails?: GrokError;
  max?: number;
}) {
  const log: Log = [];
  const fallbacks: FallbackInfo[] = [];
  const client = createRoutedClient({
    xai: fake("xai", log, options.xaiFails),
    claude: { fast: fake("fast", log, options.claudeFails), standard: fake("std", log, options.claudeFails) },
    tasks: new Set(options.tasks),
    fallback: options.fallback ?? false,
    maxClaudeInputTokens: options.max ?? 500_000,
    onFallback: (info) => fallbacks.push(info),
  });
  return { client, log, fallbacks };
}

const ask = { system: "S", user: "U" };
const structured = { ...ask, schemaName: "x", schema: { type: "object" } };

describe("llm router", () => {
  it("keeps everything on xAI when no task is routed to Claude", async () => {
    const { client, log } = build({ tasks: [] });
    await client.completeStructured(structured);
    await client.streamText!(ask);
    await client.streamStructured!(structured);
    await client.completeText(ask);
    expect(log).toEqual(["xai.completeStructured", "xai.streamText", "xai.streamStructured", "xai.completeText"]);
  });

  it("sends each task to its Claude model", async () => {
    const { client, log } = build({ tasks: ["extract", "answer", "document"] });
    await client.completeStructured(structured);
    await client.streamText!(ask);
    await client.streamStructured!(structured);
    await client.completeText(ask);
    expect(log).toEqual(["fast.completeStructured", "std.streamText", "std.streamStructured", "std.completeText"]);
  });

  it("routes only the tasks that were chosen", async () => {
    const { client, log } = build({ tasks: ["extract"] });
    await client.completeStructured(structured);
    await client.streamText!(ask);
    expect(log).toEqual(["fast.completeStructured", "xai.streamText"]);
  });

  it("keeps web search, tools, and embeddings on xAI", async () => {
    const { client, log } = build({ tasks: ["extract", "answer", "document"] });
    await client.completeText({ ...ask, webSearch: true });
    await client.completeWithTools!({ ...ask, tools: [] });
    await client.embed!({ texts: ["a"], model: "m", dimensions: 1 });
    expect(log).toEqual(["xai.completeText", "xai.completeWithTools", "xai.embed"]);
  });

  it("keeps a very large request on xAI", async () => {
    const { client, log } = build({ tasks: ["answer"], max: 10 });
    await client.streamText!({ system: "S", user: "x".repeat(400) });
    await client.streamText!(ask);
    expect(log).toEqual(["xai.streamText", "std.streamText"]);
  });

  it("does not fall back unless asked", async () => {
    const { client, log } = build({ tasks: ["answer"], claudeFails: new GrokError("down", true, 529, "claude") });
    let failed = false;
    await client.streamText!(ask).catch(() => {
      failed = true;
    });
    expect(failed).toBe(true);
    expect(log).toEqual(["std.streamText"]);
  });

  it("falls back from Claude to xAI and reports it", async () => {
    const { client, log, fallbacks } = build({
      tasks: ["answer"],
      fallback: true,
      claudeFails: new GrokError("down", true, 529, "claude"),
    });
    const result = await client.streamText!(ask);
    expect(result.text).toBe("xai");
    expect(log).toEqual(["std.streamText", "xai.streamText"]);
    expect(fallbacks).toEqual([{ task: "answer", from: "claude", to: "xai", status: 529, message: "down" }]);
  });

  it("falls back from xAI to Claude for a task that stayed on xAI", async () => {
    const { client, log } = build({ tasks: [], fallback: true, xaiFails: new GrokError("quota", true, 429) });
    const result = await client.completeStructured(structured);
    expect(result.text).toBe("fast");
    expect(log).toEqual(["xai.completeStructured", "fast.completeStructured"]);
  });

  it("sends web search and the bot's own tools to Claude only when chosen", async () => {
    const tool = { type: "function", name: "save_note" };
    const off = build({ tasks: ["extract", "answer", "document"] });
    await off.client.completeText({ ...ask, webSearch: true });
    await off.client.completeWithTools!({ ...ask, tools: [tool] });
    expect(off.log).toEqual(["xai.completeText", "xai.completeWithTools"]);

    const on = build({ tasks: ["web", "tools"] });
    await on.client.completeText({ ...ask, webSearch: true });
    await on.client.completeWithTools!({ ...ask, tools: [tool] });
    expect(on.log).toEqual(["std.completeText", "std.completeWithTools"]);
  });

  it("keeps a request that uses X search or the code interpreter on xAI", async () => {
    const { client, log } = build({ tasks: ["web", "tools"], fallback: true });
    await client.completeWithTools!({ ...ask, tools: [{ type: "web_search" }, { type: "x_search" }] });
    await client.completeWithTools!({ ...ask, tools: [{ type: "function", name: "save_note" }, { type: "code_interpreter" }] });
    expect(log).toEqual(["xai.completeWithTools", "xai.completeWithTools"]);
  });

  it("does not switch provider in the middle of a tool loop", async () => {
    const tool = { type: "function", name: "save_note" };
    const { client, log } = build({
      tasks: ["tools"],
      fallback: true,
      claudeFails: new GrokError("down", true, 529, "claude"),
    });
    let failed = false;
    await client.completeWithTools!({ ...ask, tools: [tool] }).catch(() => undefined);
    log.length = 0;
    await client.completeWithTools!({ ...ask, tools: [tool], input: [{ role: "user", content: "U" }] }).catch(() => {
      failed = true;
    });
    expect(failed).toBe(true);
    expect(log).toEqual(["std.completeWithTools"]);
  });

  it("falls back on a web search when asked", async () => {
    const { client, log } = build({ tasks: [], fallback: true, xaiFails: new GrokError("quota", true, 429) });
    const result = await client.completeText({ ...ask, webSearch: true });
    expect(result.text).toBe("std");
    expect(log).toEqual(["xai.completeText", "std.completeText"]);
  });
});
