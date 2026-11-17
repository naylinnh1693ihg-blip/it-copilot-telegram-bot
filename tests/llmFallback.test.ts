import type Anthropic from "@anthropic-ai/sdk";
import { DateTime } from "luxon";
import { describe, expect, it, vi } from "vitest";
import { buildStatus } from "../src/bot/handlers/messages.js";
import { createClaudeClient, type ClaudeCreateParams, type ClaudeMessagesApi } from "../src/services/claude/anthropic.js";
import { formatWebSearchReply } from "../src/services/assistant/execute.js";
import { formatWeekCost } from "../src/services/assistant/weekCost.js";
import { handleText } from "../src/services/assistant/handleText.js";
import { runGrokAgent } from "../src/services/assistant/agent.js";
import { answerWithRag } from "../src/services/rag/retrieve.js";
import { createResilientClient, type LlmClient, type ResponseCreate, type ResponseStreamCreate } from "../src/services/grok/client.js";
import { createFallbackClient, fallbackReason, selectLlmClient } from "../src/services/llm/fallback.js";
import { blankIntent, INTENT_JSON_SCHEMA, IntentSchema } from "../src/types/intent.js";
import { ClaudeError, GenerationStoppedError, GrokError, isGenerationStopped, toUserMessage } from "../src/utils/errors.js";
import { silentLogger, type AppLogger } from "../src/utils/logger.js";
import type { Clock } from "../src/utils/time.js";
import { owner, testDeps, ZONE } from "./helpers.js";

type BetaMessage = Anthropic.Beta.BetaMessage;

const COOLDOWN = 300_000;

function message(overrides: Record<string, unknown> = {}): BetaMessage {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text: "Claude answer.", citations: null }],
    stop_reason: "end_turn",
    stop_details: null,
    usage: { input_tokens: 100, output_tokens: 20 },
    ...overrides,
  } as unknown as BetaMessage;
}

/** A fake of client.beta.messages. `replies` are returned in order; streams emit the reply's text as deltas. */
function fakeAnthropic(replies: BetaMessage[]): ClaudeMessagesApi & { requests: ClaudeCreateParams[]; streams: number } {
  const queue = [...replies];
  const next = () => {
    const reply = queue.shift();
    if (!reply) throw new Error("no more fake Claude replies");
    return reply;
  };
  const api = {
    requests: [] as ClaudeCreateParams[],
    streams: 0,
    async create(body: ClaudeCreateParams) {
      api.requests.push(structuredClone(body));
      return next();
    },
    stream(body: ClaudeCreateParams) {
      api.requests.push(structuredClone(body));
      api.streams += 1;
      const listeners: Array<(delta: string) => void> = [];
      return {
        on(_event: "text", listener: (delta: string) => void) {
          listeners.push(listener);
          return this;
        },
        async finalMessage() {
          const reply = next();
          for (const block of reply.content) {
            if (block.type !== "text") continue;
            for (const piece of block.text.match(/.{1,6}/gs) ?? []) listeners.forEach((listener) => listener(piece));
          }
          return reply;
        },
      };
    },
  };
  return api;
}

function httpError(status: number, message = `status ${status}`, headers?: Record<string, string>): Error {
  return Object.assign(new Error(message), { status, ...(headers ? { headers: new Headers(headers) } : {}) });
}

function grokClient(create: ResponseCreate, stream?: ResponseStreamCreate): LlmClient & { calls: () => number } {
  let calls = 0;
  const client = createResilientClient({
    model: "grok-4.7",
    sleep: async () => undefined,
    create: async (body, options) => {
      calls += 1;
      return create(body, options);
    },
    stream: stream
      ? (body, options) => {
          calls += 1;
          return stream(body, options);
        }
      : undefined,
  });
  return Object.assign(client, { calls: () => calls });
}

function movableClock(start = "2026-10-30T10:00:00.000+04:00"): Clock & { advance: (ms: number) => void } {
  let at = DateTime.fromISO(start, { zone: ZONE }).toMillis();
  return {
    now: () => DateTime.fromMillis(at, { zone: ZONE }),
    advance: (ms: number) => {
      at += ms;
    },
  };
}

function recordingLogger(): AppLogger & { events: Array<Record<string, unknown>> } {
  const events: Array<Record<string, unknown>> = [];
  const push = (obj: Record<string, unknown>) => events.push(obj);
  return { events, info: push, warn: push, error: push, debug: push };
}

const intentJson = JSON.stringify(blankIntent({ intent: "clarify", clarification_question: "Which document do you mean?" }));

describe("Claude fallback", () => {
  it("answers with Claude when Grok returns 429 and records the Claude model in ai_usage", async () => {
    const { deps, db } = testDeps({ ANTHROPIC_API_KEY: "sk-ant-test-secret-value" });
    const user = await owner(db);
    const grok = grokClient(async () => {
      throw httpError(429, "rate limited");
    });
    const anthropic = fakeAnthropic([message({ content: [{ type: "text", text: intentJson, citations: null }] })]);
    const logger = recordingLogger();
    deps.llm = createFallbackClient({
      primary: grok,
      backup: createClaudeClient({ api: anthropic }),
      logger,
      clock: movableClock(),
      cooldownMs: COOLDOWN,
    });

    const reply = await handleText(deps, user, "Read Avaya Administration and make a keynote for a presentation.");
    expect(reply.text).toContain("Which document do you mean?");
    expect(anthropic.requests).toHaveLength(1);

    const usage = await db.listUsageEvents(user.id, "2026-10-01T00:00:00.000Z", "2026-12-01T00:00:00.000Z");
    expect(usage.map((row) => row.model)).toEqual(["claude-opus-5-5"]);

    const switches = logger.events.filter((event) => event.event === "llm_fallback");
    expect(switches).toEqual([{ event: "llm_fallback", from: "grok", to: "claude", reason: "rate_limited", status: 429 }]);
  });

  it("sends calls straight to Claude during the cooldown, then tries Grok first again", async () => {
    let grokFails = true;
    const grok = grokClient(async () => {
      if (grokFails) throw httpError(503);
      return { output_text: "Grok answer.", usage: { input_tokens: 1, output_tokens: 1 } };
    });
    const anthropic = fakeAnthropic([message(), message()]);
    const clock = movableClock();
    const llm = createFallbackClient({ primary: grok, backup: createClaudeClient({ api: anthropic }), logger: silentLogger, clock, cooldownMs: COOLDOWN });

    expect((await llm.completeText({ system: "s", user: "u" })).model).toBe("claude-opus-5-5");
    const grokCallsAfterFailure = grok.calls();
    expect(grokCallsAfterFailure).toBe(2); // Grok's own single retry, then the switch.
    expect(llm.state()).toMatchObject({ active: "claude", reason: "server_error" });

    clock.advance(COOLDOWN - 1_000);
    expect((await llm.completeText({ system: "s", user: "u" })).model).toBe("claude-opus-5-5");
    expect(grok.calls()).toBe(grokCallsAfterFailure);

    grokFails = false;
    clock.advance(2_000);
    const after = await llm.completeText({ system: "s", user: "u" });
    expect(after.text).toBe("Grok answer.");
    expect(after.model).toBe("grok-4.7");
    expect(grok.calls()).toBe(grokCallsAfterFailure + 1);
    expect(llm.state()).toEqual({ active: "grok" });
    expect(anthropic.requests).toHaveLength(2);
  });

  it("stays on Claude for Grok's retry-after when it is longer than the cooldown", async () => {
    const grok = grokClient(async () => {
      throw httpError(429, "slow down", { "retry-after": "900" });
    });
    const clock = movableClock();
    const llm = createFallbackClient({ primary: grok, backup: createClaudeClient({ api: fakeAnthropic([message()]) }), logger: silentLogger, clock, cooldownMs: COOLDOWN });
    await llm.completeText({ system: "s", user: "u" });
    const until = DateTime.fromISO(llm.state().until ?? "").toMillis();
    expect(until - clock.now().toMillis()).toBe(900_000);
  });

  it("does not fall back on a 400", async () => {
    const grok = grokClient(async () => {
      throw httpError(400, "bad request");
    });
    const anthropic = fakeAnthropic([message()]);
    const llm = createFallbackClient({ primary: grok, backup: createClaudeClient({ api: anthropic }), logger: silentLogger, clock: movableClock(), cooldownMs: COOLDOWN });
    const error = await llm.completeText({ system: "s", user: "u" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GrokError);
    expect((error as GrokError).status).toBe(400);
    expect(anthropic.requests).toHaveLength(0);
    expect(llm.state()).toEqual({ active: "grok" });
  });

  it("does not fall back or report an error when the user presses Stop", async () => {
    const controller = new AbortController();
    const grok = grokClient(async () => {
      controller.abort();
      throw Object.assign(new Error("Request was aborted."), { name: "APIUserAbortError" });
    });
    const anthropic = fakeAnthropic([message()]);
    const llm = createFallbackClient({ primary: grok, backup: createClaudeClient({ api: anthropic }), logger: silentLogger, clock: movableClock(), cooldownMs: COOLDOWN });
    const error = await llm.completeText({ system: "s", user: "u", signal: controller.signal }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GenerationStoppedError);
    expect(isGenerationStopped(error)).toBe(true);
    expect(toUserMessage(error)).toBe("Stopped.");
    expect(anthropic.requests).toHaveLength(0);
  });

  it("falls back on billing errors and outages, never on refusals or other client errors", () => {
    expect(fallbackReason(new GrokError("insufficient credits", false, 402))).toBe("billing");
    expect(fallbackReason(new GrokError("Your team has run out of credits", false, 403))).toBe("billing");
    expect(fallbackReason(new GrokError("forbidden", false, 403))).toBeNull();
    expect(fallbackReason(new GrokError("timeout", true, 0, { kind: "transport" }))).toBe("unreachable");
    expect(fallbackReason(new GrokError("empty", true))).toBeNull();
    expect(fallbackReason(new ClaudeError("declined", false, 0, { kind: "refusal" }))).toBeNull();
    expect(fallbackReason(new GenerationStoppedError())).toBeNull();
  });

  it("surfaces the error when Grok fails after the first streamed delta", async () => {
    const grok = grokClient(
      async () => ({ output_text: "unused" }),
      async function* () {
        yield { type: "response.output_text.delta", delta: "Grok partial answer" };
        throw httpError(503);
      },
    );
    const anthropic = fakeAnthropic([message()]);
    const llm = createFallbackClient({ primary: grok, backup: createClaudeClient({ api: anthropic }), logger: silentLogger, clock: movableClock(), cooldownMs: COOLDOWN });
    const shown: string[] = [];
    const error = await llm.streamText({ system: "s", user: "u", onDelta: (text) => void shown.push(text) }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GrokError);
    expect(shown[0]).toBe("Grok partial answer");
    expect(shown.some((text) => text.includes("Claude"))).toBe(false);
    expect(anthropic.streams).toBe(0);
  });

  it("streams the answer from Claude when Grok fails before the first delta", async () => {
    const grok = grokClient(
      async () => ({ output_text: "unused" }),
      // eslint-disable-next-line require-yield
      async function* () {
        throw httpError(429);
      },
    );
    const anthropic = fakeAnthropic([message({ content: [{ type: "text", text: "Claude streamed answer.", citations: null }] })]);
    const llm = createFallbackClient({ primary: grok, backup: createClaudeClient({ api: anthropic }), logger: silentLogger, clock: movableClock(), cooldownMs: COOLDOWN });
    const shown: string[] = [];
    const result = await llm.streamText({ system: "s", user: "u", onDelta: (text) => void shown.push(text) });
    expect(result.text).toBe("Claude streamed answer.");
    expect(result.model).toBe("claude-opus-5-5");
    expect(anthropic.streams).toBe(1);
    expect(shown.at(-1)).toBe("Claude streamed answer.");
    expect(anthropic.requests[0]?.max_tokens).toBe(64_000);
  });

  it("always embeds with xAI, even during the cooldown", async () => {
    let embeds = 0;
    const primary: LlmClient = {
      async completeStructured() {
        throw new GrokError("rate limited", true, 429);
      },
      async completeText() {
        throw new GrokError("rate limited", true, 429);
      },
      async embed() {
        embeds += 1;
        return { vectors: [[0.1]], inputTokens: 3 };
      },
    };
    const llm = createFallbackClient({ primary, backup: createClaudeClient({ api: fakeAnthropic([message()]) }), logger: silentLogger, clock: movableClock(), cooldownMs: COOLDOWN });
    await llm.completeText({ system: "s", user: "u" });
    expect(llm.state().active).toBe("claude");
    await llm.embed?.({ texts: ["query: printer"], model: "v1", dimensions: 1 });
    expect(embeds).toBe(1);
  });

  it("keeps the plain Grok client when there is no Anthropic key", () => {
    const grok = grokClient(async () => ({ output_text: "ok" }));
    expect(selectLlmClient({ grok, claude: null, logger: silentLogger, clock: movableClock(), cooldownMs: COOLDOWN })).toBe(grok);
    const claude = createClaudeClient({ api: fakeAnthropic([]) });
    const alone = selectLlmClient({ grok: null, claude, logger: silentLogger, clock: movableClock(), cooldownMs: COOLDOWN });
    expect(alone).toBe(claude);
    expect(alone?.embed).toBeUndefined();
  });

  it("never prints the xAI or Anthropic key in /status", async () => {
    const { deps } = testDeps({ ANTHROPIC_API_KEY: "sk-ant-test-secret-value" });
    const clock = movableClock();
    const grok = grokClient(async () => {
      throw httpError(429);
    });
    const llm = createFallbackClient({ primary: grok, backup: createClaudeClient({ api: fakeAnthropic([message()]) }), logger: silentLogger, clock, cooldownMs: COOLDOWN });
    deps.llm = llm;

    const ready = buildStatus(deps, "reachable");
    expect(ready).toContain("AI: Grok (primary, grok-4.7) · Claude backup (claude-opus-5-5): ready");

    await llm.completeText({ system: "s", user: "u" });
    const active = buildStatus(deps, "reachable");
    expect(active).toContain("Claude backup (claude-opus-5-5) active until 10:05 (Grok rate-limited)");

    for (const text of [ready, active]) {
      expect(text).not.toContain("sk-ant-test-secret-value");
      expect(text).not.toContain("xai-test-secret-value");
    }
  });

  it("says both providers failed when Claude also fails after a fallback", async () => {
    const grok = grokClient(async () => {
      throw httpError(500);
    });
    const failing: ClaudeMessagesApi = {
      async create() {
        throw new ClaudeError("Claude server error (529).", true, 529);
      },
      stream() {
        throw new Error("unused");
      },
    };
    const llm = createFallbackClient({ primary: grok, backup: createClaudeClient({ api: failing }), logger: silentLogger, clock: movableClock(), cooldownMs: COOLDOWN });
    const error = await llm.completeText({ system: "s", user: "u" }).catch((caught: unknown) => caught);
    expect(toUserMessage(error)).toContain("Claude backup also failed");
  });
});

describe("RAG with the Claude backup", () => {
  it("answers from lexical search with Claude when xAI embedding and Grok both fail", async () => {
    const { deps, db } = testDeps({ ANTHROPIC_API_KEY: "sk-ant-test-secret-value" });
    const user = await owner(db);
    let embedCalls = 0;
    const grok: LlmClient = {
      async completeStructured() {
        throw new GrokError("rate limited", true, 429);
      },
      async completeText() {
        throw new GrokError("rate limited", true, 429);
      },
      async embed() {
        embedCalls += 1;
        throw new GrokError("rate limited", true, 429);
      },
    };
    const anthropic = fakeAnthropic([message({ content: [{ type: "text", text: "The floor 2 printer IP is 192.168.1.10.", citations: null }] })]);
    deps.llm = createFallbackClient({ primary: grok, backup: createClaudeClient({ api: anthropic }), logger: silentLogger, clock: movableClock(), cooldownMs: COOLDOWN });

    await handleText(deps, user, "note this: The floor 2 printer uses IP address 192.168.1.10.");
    const reply = await answerWithRag(deps, user, "What's the IP of the floor 2 printer?");

    expect(embedCalls).toBeGreaterThan(0);
    expect(reply?.text).toContain("192.168.1.10");
    expect(reply?.text).toContain("From note #1");
    const ragRequest = anthropic.requests.at(-1)!;
    expect(JSON.stringify(ragRequest.messages)).toContain("192.168.1.10");
    expect(ragRequest.output_config?.effort).toBe("medium");
    const usage = await db.listUsageEvents(user.id, "2026-10-01T00:00:00.000Z", "2026-12-01T00:00:00.000Z");
    expect(usage.find((row) => row.purpose === "rag")?.model).toBe("claude-opus-5-5");
  });
});

describe("Claude client", () => {
  it("returns structured JSON that passes the existing zod schema, without prefill or a thinking setting", async () => {
    const anthropic = fakeAnthropic([message({ content: [{ type: "text", text: intentJson, citations: null }] })]);
    const claude = createClaudeClient({ api: anthropic });
    const result = await claude.completeStructured({ system: "rules", user: "help me", schemaName: "copilot_intent", schema: INTENT_JSON_SCHEMA });
    expect(IntentSchema.safeParse(JSON.parse(result.text)).success).toBe(true);

    const request = anthropic.requests[0]!;
    expect(request.output_config?.format?.type).toBe("json_schema");
    expect(request.output_config?.effort).toBe("low");
    expect(request).not.toHaveProperty("thinking");
    expect(request.messages.at(-1)?.role).toBe("user");
    expect(request.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(request.fallbacks).toBe("default");
  });

  it("puts note text in user content, never in system, and sends images before the text", async () => {
    const anthropic = fakeAnthropic([message()]);
    const claude = createClaudeClient({ api: anthropic });
    await claude.completeText({
      system: "Summarize.",
      user: "<untrusted_document>secret plan</untrusted_document>",
      images: [{ mime: "image/png", base64: "aGVsbG8=" }],
    });
    const request = anthropic.requests[0]!;
    expect(request.system).toBe("Summarize.");
    const content = request.messages[0]?.content as Array<{ type: string }>;
    expect(content.map((block) => block.type)).toEqual(["image", "text"]);
    expect(JSON.stringify(request.system)).not.toContain("secret plan");
  });

  it("runs one tool round-trip with all tool results in one user message and thinking kept unchanged", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    const thinking = { type: "thinking", thinking: "", signature: "sig-abc123" };
    const firstContent = [
      thinking,
      { type: "text", text: "Checking.", citations: null },
      { type: "tool_use", id: "toolu_01", name: "get_open_tasks", input: {} },
      { type: "tool_use", id: "toolu_02", name: "search_local_knowledge", input: { query: "printer" } },
    ];
    const anthropic = fakeAnthropic([
      message({ content: firstContent, stop_reason: "tool_use" }),
      message({ content: [{ type: "text", text: "You have no open tasks.", citations: null }] }),
    ]);
    deps.llm = createClaudeClient({ api: anthropic });

    const reply = await runGrokAgent(deps, user, "What are my open tasks and what did I save about the printer?", ["get_open_tasks", "search_local_knowledge"]);
    expect(reply.text).toBe("You have no open tasks.");
    expect(anthropic.requests).toHaveLength(2);

    const first = anthropic.requests[0]!;
    expect(first.tool_choice).toEqual({ type: "auto" });
    expect(first.tools?.map((tool) => ("name" in tool ? tool.name : ""))).toEqual(["search_local_knowledge", "get_open_tasks"]);
    expect(first.tools?.every((tool) => "strict" in tool && tool.strict === true)).toBe(true);

    const second = anthropic.requests[1]!;
    expect(second.messages.map((entry) => entry.role)).toEqual(["user", "assistant", "user"]);
    expect(second.messages[1]?.content).toEqual(firstContent);
    const results = second.messages[2]?.content as Array<{ type: string; tool_use_id: string }>;
    expect(results.map((block) => [block.type, block.tool_use_id])).toEqual([
      ["tool_result", "toolu_01"],
      ["tool_result", "toolu_02"],
    ]);
    const usage = await db.listUsageEvents(user.id, "2026-10-01T00:00:00.000Z", "2026-12-01T00:00:00.000Z");
    expect(usage.every((row) => row.model === "claude-opus-5-5")).toBe(true);
  });

  it("returns a plain refusal message without retrying", async () => {
    const anthropic = fakeAnthropic([message({ content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: null } })]);
    const claude = createClaudeClient({ api: anthropic });
    const error = await claude.completeText({ system: "s", user: "u" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ClaudeError);
    expect((error as ClaudeError).kind).toBe("refusal");
    expect(toUserMessage(error)).toBe("Claude declined this request, so I have no answer for it. Try rewording the question.");
    expect(anthropic.requests).toHaveLength(1);
  });

  it("uses Claude web search, resumes pause_turn, and keeps source links", async () => {
    const searchResult = {
      type: "web_search_tool_result",
      tool_use_id: "srvtoolu_1",
      content: [{ type: "web_search_result", url: "https://git-scm.com/docs/git-reset", title: "git-reset", encrypted_content: "x", page_age: null }],
    };
    const anthropic = fakeAnthropic([
      message({
        stop_reason: "pause_turn",
        content: [{ type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "git reset" } }, searchResult],
      }),
      message({
        content: [
          { type: "web_search_tool_result", tool_use_id: "srvtoolu_2", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } },
          {
            type: "text",
            text: "Git reset moves HEAD.",
            citations: [{ type: "web_search_result_location", url: "https://git-scm.com/docs/git-reset", title: "git-reset", cited_text: "Reset current HEAD", encrypted_index: "e" }],
          },
        ],
      }),
    ]);
    const claude = createClaudeClient({ api: anthropic, logger: silentLogger });
    const result = await claude.completeText({ system: "s", user: "u", webSearch: true });
    expect(anthropic.requests).toHaveLength(2);
    expect(anthropic.requests[0]?.tools).toEqual([{ type: "web_search_20260209", name: "web_search", max_uses: 5 }]);
    expect(anthropic.requests[1]?.messages.at(-1)?.role).toBe("assistant");
    expect(result.text).toBe("Git reset moves HEAD. [[1]](https://git-scm.com/docs/git-reset)");
    expect(formatWebSearchReply(result.text)).toContain("Sources:\n[1] https://git-scm.com/docs/git-reset");
  });

  it("maps a 429 from the Anthropic SDK to a retryable error", async () => {
    const { RateLimitError } = (await import("@anthropic-ai/sdk")).default;
    const api: ClaudeMessagesApi = {
      create: vi.fn(async () => {
        throw new RateLimitError(429, { type: "error" }, "rate limited", new Headers({ "retry-after": "30" }));
      }),
      stream() {
        throw new Error("unused");
      },
    };
    const error = await createClaudeClient({ api }).completeText({ system: "s", user: "u" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ClaudeError);
    expect(error).toMatchObject({ status: 429, retryable: true, retryAfterMs: 30_000 });
  });
});

describe("Claude failure reasons", () => {
  async function failBoth(claudeError: unknown) {
    const grok = grokClient(async () => {
      throw httpError(429);
    });
    const api: ClaudeMessagesApi = {
      async create() {
        throw claudeError;
      },
      stream() {
        throw new Error("unused");
      },
    };
    const logger = recordingLogger();
    const llm = createFallbackClient({ primary: grok, backup: createClaudeClient({ api }), logger, clock: movableClock(), cooldownMs: COOLDOWN });
    const error = await llm.completeText({ system: "s", user: "u" }).catch((caught: unknown) => caught);
    return { error, logged: logger.events.find((event) => event.event === "llm_backup_failed") };
  }

  it("logs Anthropic's reason and says plainly when the Claude account has no credit", async () => {
    const { BadRequestError } = (await import("@anthropic-ai/sdk")).default;
    const lowCredit = new BadRequestError(
      400,
      { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." }, request_id: "req_123" },
      undefined,
      new Headers({ "request-id": "req_123" }),
    );
    const { error, logged } = await failBoth(lowCredit);
    expect(logged).toMatchObject({ provider: "claude", status: 400 });
    expect(String(logged?.message)).toContain("credit balance is too low");
    expect(toUserMessage(error)).toBe(
      "Grok was unavailable, and the Claude backup has no Anthropic credit left, so I did not get an answer. Add credit at https://platform.claude.com (Settings → Billing), then try again.",
    );
  });

  it("says plainly when Anthropic rejects the API key", async () => {
    const { AuthenticationError } = (await import("@anthropic-ai/sdk")).default;
    const badKey = new AuthenticationError(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, undefined, new Headers());
    const { error, logged } = await failBoth(badKey);
    expect(String(logged?.message)).toContain("invalid x-api-key");
    expect(toUserMessage(error)).toContain("Anthropic rejected the API key");
  });
});

describe("week cost with the Claude backup", () => {
  it("shows Grok and Claude separately", () => {
    const text = formatWeekCost([
      { model: "grok-4.7", inputTokens: 100_000, outputTokens: 0 },
      { model: "claude-opus-5-5", inputTokens: 1_000_000, outputTokens: 100_000 },
    ]);
    expect(text).toContain("Grok: $0.20 · Claude: $6.00");
    expect(text).toContain("claude-opus-5-5: $6.00");
  });
});
