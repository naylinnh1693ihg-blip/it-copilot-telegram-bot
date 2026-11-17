import Anthropic from "@anthropic-ai/sdk";
import { transformJSONSchema } from "@anthropic-ai/sdk/lib/transform-json-schema";
import { ClaudeError, GenerationStoppedError, retryAfterFromHeaders } from "../../utils/errors.js";
import type { AppLogger } from "../../utils/logger.js";
import { currentAbortSignal } from "../grok/abort.js";
import type { AgentTurn, LlmClient, LlmEffort, LlmResult, ToolCall } from "../grok/client.js";
import { createPreviewGate } from "../grok/streamPreview.js";

/**
 * The only code that calls Anthropic. Claude is the backup when Grok is rate-limited,
 * out of credit, or down (see src/services/llm/fallback.ts).
 *
 * - Thinking is always on for Claude Opus 5.5; `thinking` is omitted and output_config.effort sets the depth.
 * - Requests use the beta endpoint with server-side fallbacks, so a declined request is re-run on
 *   Anthropic's recommended fallback model inside the same call. A final stop_reason "refusal" means the
 *   whole chain declined.
 * - No assistant prefill and no forced tool_choice: Claude Opus 5.5 rejects both with a 400.
 * - No embeddings: the Claude API has none. Embeddings stay on xAI.
 * - Note and document text arrive already wrapped by the caller and go in user content, never in `system`.
 */

type BetaMessage = Anthropic.Beta.BetaMessage;
type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
type BetaContentBlock = Anthropic.Beta.BetaContentBlock;
type BetaContentBlockParam = Anthropic.Beta.BetaContentBlockParam;
type BetaToolUnion = Anthropic.Beta.BetaToolUnion;
type BetaToolResultBlockParam = Anthropic.Beta.BetaToolResultBlockParam;
export type ClaudeCreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

export interface ClaudeRequestOptions {
  signal?: AbortSignal;
  timeout?: number;
}

export interface ClaudeStreamHandle {
  on(event: "text", listener: (delta: string) => void): unknown;
  finalMessage(): Promise<BetaMessage>;
}

/** The two SDK calls this module makes. Tests pass a fake; production wraps client.beta.messages. */
export interface ClaudeMessagesApi {
  create(body: ClaudeCreateParams, options?: ClaudeRequestOptions): Promise<BetaMessage>;
  stream(body: ClaudeCreateParams, options?: ClaudeRequestOptions): ClaudeStreamHandle;
}

type Image = { mime: "image/jpeg" | "image/png"; base64: string };

export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";
const MAX_TOKENS = 16_000;
const STREAM_MAX_TOKENS = 64_000;
const MAX_PAUSE_CONTINUATIONS = 4;
const MAX_SOURCES = 5;
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const CACHED_TURNS = 200;

export function createClaudeClient(options: {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  logger?: AppLogger;
  /** Injected in tests. Production builds the official SDK client. */
  api?: ClaudeMessagesApi;
}): LlmClient {
  const model = options.model || DEFAULT_CLAUDE_MODEL;
  const logger = options.logger;
  const api = options.api ?? sdkApi(options.apiKey ?? "", options.timeoutMs);

  // Claude's own assistant turns, keyed by the first tool_use id in the turn. The agent loop sends back a
  // provider-neutral transcript (Responses-API items); this lets us replay Claude's full content, including
  // thinking blocks, unchanged on the next request.
  const turnCache = new Map<string, BetaMessageParam[]>();
  const rememberTurn = (id: string, turn: BetaMessageParam[]) => {
    turnCache.set(id, turn);
    while (turnCache.size > CACHED_TURNS) {
      const oldest = turnCache.keys().next().value;
      if (oldest === undefined) break;
      turnCache.delete(oldest);
    }
  };

  function params(system: string, messages: BetaMessageParam[], effort: LlmEffort, maxTokens = MAX_TOKENS): ClaudeCreateParams {
    return {
      model,
      max_tokens: maxTokens,
      system,
      messages,
      output_config: { effort },
      betas: [FALLBACK_BETA],
      fallbacks: "default",
    };
  }

  /** Sends the request and resumes on pause_turn (server tools hit their iteration limit). */
  async function createWithContinuation(
    body: ClaudeCreateParams,
    signal: AbortSignal | undefined,
  ): Promise<{ final: BetaMessage; segments: BetaMessage[]; inputTokens: number; outputTokens: number }> {
    const segments: BetaMessage[] = [];
    const assistant: BetaMessageParam[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    for (let round = 0; ; round += 1) {
      stopIfAborted(signal);
      const message = await api.create({ ...body, messages: [...body.messages, ...assistant] }, requestOptions(signal));
      segments.push(message);
      inputTokens += message.usage?.input_tokens ?? 0;
      outputTokens += message.usage?.output_tokens ?? 0;
      if (message.stop_reason !== "pause_turn") return { final: message, segments, inputTokens, outputTokens };
      if (round >= MAX_PAUSE_CONTINUATIONS) {
        throw new ClaudeError("Claude did not finish its search in time.", true, 0, { kind: "output" });
      }
      // Send the paused content back as-is. The API sees the trailing server_tool_use and resumes.
      assistant.push({ role: "assistant", content: echoContent(message.content) });
    }
  }

  function checkStop(message: BetaMessage, purpose: string): void {
    if (message.stop_reason === "refusal") {
      logger?.warn(
        { event: "claude_refusal", purpose, model: message.model, category: message.stop_details?.category ?? null },
        "Claude and its fallback declined the request",
      );
      throw new ClaudeError("Claude declined the request.", false, 0, { kind: "refusal" });
    }
    if (message.stop_reason === "max_tokens") {
      logger?.warn({ event: "claude_max_tokens", purpose, model: message.model }, "Claude reply reached max_tokens");
    }
  }

  async function complete(
    purpose: string,
    body: ClaudeCreateParams,
    signal: AbortSignal | undefined,
    textOptions: { expectJson?: boolean; sources?: boolean } = {},
  ): Promise<LlmResult> {
    try {
      const { final, segments, inputTokens, outputTokens } = await createWithContinuation(body, signal);
      checkStop(final, purpose);
      const content = segments.flatMap((segment) => segment.content);
      if (textOptions.sources) logSearchErrors(content, logger);
      const text = (textOptions.sources ? textWithSources(content) : plainText(content)).trim();
      if (!text) throw new ClaudeError("Claude returned an empty response.", true, 0, { kind: "output" });
      if (textOptions.expectJson) assertJson(text);
      return { text, inputTokens, outputTokens, model: final.model };
    } catch (error) {
      throw asClaudeError(error, signal);
    }
  }

  async function stream(
    purpose: string,
    body: ClaudeCreateParams,
    hooks: { expectJson: boolean; minIntervalMs?: number; onDelta?: (snapshot: string) => Promise<void> | void; signal?: AbortSignal },
  ): Promise<LlmResult> {
    const signal = hooks.signal;
    try {
      stopIfAborted(signal);
      const gate = createPreviewGate({
        minIntervalMs: hooks.minIntervalMs ?? 1_100,
        publish: (snapshot) => hooks.onDelta?.(snapshot),
      });
      let streamed = "";
      let previews: Promise<void> = Promise.resolve();
      const handle = api.stream(body, requestOptions(signal));
      handle.on("text", (delta) => {
        streamed += delta;
        const snapshot = streamed;
        previews = previews.then(() => gate.push(snapshot));
      });
      const message = await handle.finalMessage();
      await previews;
      stopIfAborted(signal);
      checkStop(message, purpose);
      const text = plainText(message.content).trim() || streamed.trim();
      if (!text) throw new ClaudeError("Claude returned an empty response.", true, 0, { kind: "output" });
      await gate.flush();
      if (hooks.expectJson) assertJson(text);
      return {
        text,
        inputTokens: message.usage?.input_tokens ?? 0,
        outputTokens: message.usage?.output_tokens ?? 0,
        model: message.model,
      };
    } catch (error) {
      throw asClaudeError(error, signal);
    }
  }

  function structuredParams(input: { system: string; user: string; schema: Record<string, unknown>; images?: Image[] }, effort: LlmEffort, maxTokens?: number): ClaudeCreateParams {
    const body = params(input.system, [userMessage(input.user, input.images)], effort, maxTokens);
    // The SDK helper drops keywords structured outputs do not support (maxItems, minLength, ...).
    // Callers still validate the parsed JSON with their zod schema.
    body.output_config = { effort, format: { type: "json_schema", schema: transformJSONSchema(input.schema) } };
    return body;
  }

  return {
    completeStructured(input) {
      const signal = input.signal ?? currentAbortSignal();
      return complete("structured", structuredParams(input, input.effort ?? "low"), signal, { expectJson: true });
    },
    streamStructured(input) {
      return stream("structured_stream", structuredParams(input, input.effort ?? "high", STREAM_MAX_TOKENS), {
        expectJson: true,
        minIntervalMs: input.minIntervalMs,
        onDelta: input.onDelta,
        signal: input.signal ?? currentAbortSignal(),
      });
    },
    streamText(input) {
      return stream("text_stream", params(input.system, [userMessage(input.user, input.images)], input.effort ?? "medium", STREAM_MAX_TOKENS), {
        expectJson: false,
        minIntervalMs: input.minIntervalMs,
        onDelta: input.onDelta,
        signal: input.signal ?? currentAbortSignal(),
      });
    },
    completeText(input) {
      const signal = input.signal ?? currentAbortSignal();
      const body = params(input.system, [userMessage(input.user, input.images)], input.effort ?? "medium");
      if (input.webSearch) body.tools = [webSearchTool()];
      return complete(input.webSearch ? "web_search" : "text", body, signal, { sources: input.webSearch === true });
    },
    async completeWithTools(input): Promise<AgentTurn> {
      const signal = input.signal ?? currentAbortSignal();
      const transcript = input.input
        ? fromResponsesInput(input.input, turnCache)
        : { system: input.system, messages: [userMessage(input.user)] };
      const body = params(transcript.system || input.system, transcript.messages, input.effort ?? "low");
      body.tools = claudeTools(input.tools);
      body.tool_choice = { type: "auto" };
      try {
        const { final, segments, inputTokens, outputTokens } = await createWithContinuation(body, signal);
        checkStop(final, "agent");
        const content = segments.flatMap((segment) => segment.content);
        const turn = segments.map((segment): BetaMessageParam => ({ role: "assistant", content: echoContent(segment.content) }));
        // Only tool_use blocks that are echoed back get a tool_result (see echoContent).
        const echoed = turn.flatMap((message) => (Array.isArray(message.content) ? message.content : []));
        const functionCalls: ToolCall[] = echoed.flatMap((block) =>
          block.type === "tool_use" ? [{ callId: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) }] : [],
        );
        const firstCall = functionCalls[0];
        if (firstCall) rememberTurn(firstCall.callId, turn);
        const searched = body.tools.some((tool) => "type" in tool && tool.type === "web_search_20260209");
        if (searched) logSearchErrors(content, logger);
        const text = (searched ? textWithSources(content) : plainText(content)).trim();
        if (!text && functionCalls.length === 0) {
          throw new ClaudeError("Claude returned an empty response.", true, 0, { kind: "output" });
        }
        return { text, functionCalls, inputTokens, outputTokens, model: final.model };
      } catch (error) {
        throw asClaudeError(error, signal);
      }
    },
    // No embed: the Claude API has no embeddings endpoint.
  };
}

function sdkApi(apiKey: string, timeoutMs?: number): ClaudeMessagesApi {
  // The SDK retries 408/409/429/5xx and connection errors twice with backoff and honours retry-after.
  const client = new Anthropic({ apiKey, ...(timeoutMs ? { timeout: timeoutMs } : {}), maxRetries: 2 });
  return {
    create: (body, requestOptions) => client.beta.messages.create(body, requestOptions),
    stream: (body, requestOptions) => client.beta.messages.stream(body, requestOptions),
  };
}

function requestOptions(signal?: AbortSignal): ClaudeRequestOptions | undefined {
  return signal ? { signal } : undefined;
}

function stopIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new GenerationStoppedError();
}

function assertJson(text: string): void {
  try {
    JSON.parse(text);
  } catch {
    throw new ClaudeError("Claude returned invalid JSON.", true, 0, { kind: "output" });
  }
}

function userMessage(text: string, images?: Image[]): BetaMessageParam {
  if (!images?.length) return { role: "user", content: text };
  return {
    role: "user",
    content: [
      ...images.map((image): BetaContentBlockParam => ({
        type: "image",
        source: { type: "base64", media_type: image.mime, data: image.base64 },
      })),
      { type: "text", text },
    ],
  };
}

function webSearchTool(): BetaToolUnion {
  // The 20260209 version filters results with built-in code execution, so code execution is not declared too.
  return { type: "web_search_20260209", name: "web_search", max_uses: MAX_SOURCES };
}

/** Responses-API tool definitions (src/services/grok/tools.ts) as Anthropic tools. */
export function claudeTools(tools: Array<Record<string, unknown>>): BetaToolUnion[] {
  const out: BetaToolUnion[] = [];
  let web = false;
  let code = false;
  for (const tool of tools) {
    if (tool.type === "function" && typeof tool.name === "string") {
      const schema = (tool.parameters && typeof tool.parameters === "object" ? tool.parameters : { type: "object", properties: {} }) as Record<string, unknown>;
      const strictable = schema.type === "object" && schema.additionalProperties === false;
      out.push({
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : "",
        input_schema: (strictable ? transformJSONSchema(schema) : schema) as Anthropic.Beta.BetaTool.InputSchema,
        ...(strictable ? { strict: true } : {}),
      });
    } else if (tool.type === "web_search" || tool.type === "x_search") {
      // Claude has no X search. Its web search covers public pages, including x.com.
      web = true;
    } else if (tool.type === "code_interpreter") {
      code = true;
    }
  }
  if (web) out.push(webSearchTool());
  else if (code) out.push({ type: "code_execution_20260521", name: "code_execution" });
  return out;
}

/** Tool ids must match ^[a-zA-Z0-9_-]+$. Claude's own ids already do, so cached turns still match. */
function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_") || "call";
}

function parseObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") return {};
  try {
    const value: unknown = JSON.parse(raw || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function failed(output: string): boolean {
  const value = parseObject(output);
  return value.ok === false;
}

/**
 * Translates the agent's Responses-API transcript (system, user, function_call, function_call_output items).
 * Function calls Claude made are replaced by its cached full turn (thinking blocks included). All outputs that
 * follow one assistant turn go back as tool_result blocks in ONE user message.
 */
export function fromResponsesInput(
  items: unknown[],
  cache: Map<string, BetaMessageParam[]>,
): { system: string; messages: BetaMessageParam[] } {
  const system: string[] = [];
  const messages: BetaMessageParam[] = [];
  let index = 0;
  const row = (at: number): Record<string, unknown> | null => {
    const item = items[at];
    return item && typeof item === "object" ? (item as Record<string, unknown>) : null;
  };
  while (index < items.length) {
    const item = row(index);
    if (!item) {
      index += 1;
      continue;
    }
    if (item.role === "system" && typeof item.content === "string") {
      system.push(item.content);
      index += 1;
    } else if (item.role === "user" && typeof item.content === "string") {
      messages.push({ role: "user", content: item.content });
      index += 1;
    } else if (item.type === "function_call") {
      const calls: Record<string, unknown>[] = [];
      while (row(index)?.type === "function_call") {
        calls.push(row(index)!);
        index += 1;
      }
      const cached = cache.get(safeId(String(calls[0]?.call_id ?? "")));
      if (cached) {
        messages.push(...cached);
      } else {
        messages.push({
          role: "assistant",
          content: calls.map((call): BetaContentBlockParam => ({
            type: "tool_use",
            id: safeId(String(call.call_id ?? "")),
            name: String(call.name ?? ""),
            input: parseObject(call.arguments),
          })),
        });
      }
    } else if (item.type === "function_call_output") {
      const results: BetaToolResultBlockParam[] = [];
      while (row(index)?.type === "function_call_output") {
        const output = row(index)!;
        const text = typeof output.output === "string" ? output.output : JSON.stringify(output.output ?? "");
        results.push({
          type: "tool_result",
          tool_use_id: safeId(String(output.call_id ?? "")),
          content: text,
          ...(failed(text) ? { is_error: true } : {}),
        });
        index += 1;
      }
      messages.push({ role: "user", content: results });
    } else {
      index += 1;
    }
  }
  return { system: system.join("\n"), messages };
}

/**
 * The assistant content to send back. Normally unchanged. After a mid-output server-side fallback, blocks
 * before the last `fallback` block are dropped unless they are text or paired server-tool blocks; the
 * fallback block itself stays where it was.
 */
export function echoContent(content: BetaContentBlock[]): BetaContentBlockParam[] {
  const lastFallback = content.map((block) => block.type).lastIndexOf("fallback");
  if (lastFallback < 0) return content as BetaContentBlockParam[];
  const resultIds = new Set(
    content.flatMap((block) => ("tool_use_id" in block && typeof block.tool_use_id === "string" ? [block.tool_use_id] : [])),
  );
  return content.filter((block, index) => {
    if (index >= lastFallback) return true;
    if (block.type === "text") return true;
    if (block.type === "server_tool_use") return resultIds.has(block.id);
    return "tool_use_id" in block;
  }) as BetaContentBlockParam[];
}

function plainText(content: BetaContentBlock[]): string {
  return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

const INLINE_SOURCE = /\[\[\d+\]\]\(https?:\/\/[^)\s]+\)/;

/**
 * Text with inline [[n]](url) markers like the Grok path, so formatWebSearchReply can list sources.
 * If Claude already wrote the markers, the text is used as-is. Otherwise markers come from the
 * web_search_result_location citations on each text block. Uncited search results are not listed.
 */
export function textWithSources(content: BetaContentBlock[]): string {
  const plain = plainText(content);
  if (INLINE_SOURCE.test(plain)) return plain;
  const numbers = new Map<string, number>();
  let out = "";
  for (const block of content) {
    if (block.type !== "text") continue;
    out += block.text;
    const marks: string[] = [];
    for (const citation of block.citations ?? []) {
      if (citation.type !== "web_search_result_location") continue;
      let number = numbers.get(citation.url);
      if (number === undefined) {
        if (numbers.size >= MAX_SOURCES) continue;
        number = numbers.size + 1;
        numbers.set(citation.url, number);
      }
      const mark = `[[${number}]](${citation.url})`;
      if (!marks.includes(mark)) marks.push(mark);
    }
    if (marks.length > 0) out = `${out.trimEnd()} ${marks.join(" ")}`;
  }
  return out;
}

/** Web search failures come back as a result block holding an error object, not as an exception. */
function logSearchErrors(content: BetaContentBlock[], logger?: AppLogger): void {
  for (const block of content) {
    if (block.type === "web_search_tool_result" && !Array.isArray(block.content)) {
      logger?.warn({ event: "claude_web_search_error", code: block.content.error_code }, "Claude web search returned an error");
    }
  }
}

/** Maps SDK errors to ClaudeError, most specific class first. A stop is reported as GenerationStoppedError. */
export function asClaudeError(error: unknown, signal?: AbortSignal): Error {
  if (error instanceof GenerationStoppedError) return error;
  if (signal?.aborted || error instanceof Anthropic.APIUserAbortError) return new GenerationStoppedError();
  if (error instanceof ClaudeError) return error;
  if (error instanceof Anthropic.RateLimitError) {
    return new ClaudeError("Claude rate limit reached.", true, 429, { retryAfterMs: retryAfterFromHeaders(error.headers) });
  }
  if (error instanceof Anthropic.InternalServerError) {
    return new ClaudeError(`Claude server error (${error.status}).`, true, error.status ?? 500);
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new ClaudeError("Claude request timed out.", true, 0, { kind: "transport" });
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new ClaudeError("Could not connect to Claude.", true, 0, { kind: "transport" });
  }
  if (error instanceof Anthropic.BadRequestError) return new ClaudeError("Claude rejected the request.", false, 400);
  if (error instanceof Anthropic.AuthenticationError) return new ClaudeError("Claude rejected the API key.", false, 401);
  if (error instanceof Anthropic.PermissionDeniedError) return new ClaudeError("Claude denied the request.", false, 403);
  if (error instanceof Anthropic.APIError) {
    const status = typeof error.status === "number" ? error.status : 0;
    return new ClaudeError(`Claude request failed (${status}).`, status === 408 || status === 409 || status >= 500, status);
  }
  return new ClaudeError("Claude request failed.", false, 0);
}
