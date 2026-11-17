import { GenerationStoppedError, GrokError, retryAfterFromHeaders } from "../../utils/errors.js";
import { currentAbortSignal } from "./abort.js";
import { createPreviewGate } from "./streamPreview.js";

export interface LlmResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  /** The model that actually answered. Record this in ai_usage, not the configured model. */
  model?: string;
}

/**
 * How hard the model should think. Grok ignores it. Claude sends it as output_config.effort:
 * low for intent routing and short chat, medium for RAG answers and summaries, high for document analysis.
 */
export type LlmEffort = "low" | "medium" | "high";

/** Which provider answers right now. Only the fallback client reports this. */
export interface LlmProviderState {
  active: "grok" | "claude";
  /** ISO time when calls go back to Grok. Present while the Claude backup is active. */
  until?: string;
  /** Why the backup is active: rate_limited, billing, server_error, or unreachable. */
  reason?: string;
}

export interface LlmRequestPolicy {
  timeoutMs?: number;
  retry?: boolean;
  signal?: AbortSignal;
}

export interface ToolCall {
  callId: string;
  name: string;
  arguments: string;
}

export interface AgentTurn extends LlmResult {
  functionCalls: ToolCall[];
}

export interface LlmClient {
  completeStructured(input: {
    system: string;
    user: string;
    schemaName: string;
    schema: Record<string, unknown>;
    images?: Array<{ mime: "image/jpeg" | "image/png"; base64: string }>;
    model?: string;
    timeoutMs?: number;
    retry?: boolean;
    /** Cancels the request (Telegram Stop button). Defaults to the ambient signal from withAbortSignal. */
    signal?: AbortSignal;
    effort?: LlmEffort;
  }): Promise<LlmResult>;
  completeText(input: {
    system: string;
    user: string;
    webSearch?: boolean;
    images?: Array<{ mime: "image/jpeg" | "image/png"; base64: string }>;
    signal?: AbortSignal;
    effort?: LlmEffort;
  }): Promise<LlmResult>;
  completeWithTools?(input: {
    system: string;
    user: string;
    tools: Array<Record<string, unknown>>;
    /** Full Responses API input for a follow-up turn. The first turn builds input from system and user. */
    input?: unknown[];
    signal?: AbortSignal;
    effort?: LlmEffort;
  }): Promise<AgentTurn>;
  embed?(input: { texts: string[]; model: string; dimensions: number }): Promise<{ vectors: number[][]; inputTokens: number }>;
  streamStructured?(input: {
    system: string;
    user: string;
    schemaName: string;
    schema: Record<string, unknown>;
    images?: Array<{ mime: "image/jpeg" | "image/png"; base64: string }>;
    model?: string;
    /** How often a preview may be published. Defaults to 1100ms. */
    minIntervalMs?: number;
    onDelta?: (snapshot: string) => Promise<void> | void;
    timeoutMs?: number;
    retry?: boolean;
    signal?: AbortSignal;
    effort?: LlmEffort;
  }): Promise<LlmResult>;
  /** Plain-text stream. Previews are throttled. The returned text is the full answer. */
  streamText?(input: {
    system: string;
    user: string;
    images?: Array<{ mime: "image/jpeg" | "image/png"; base64: string }>;
    minIntervalMs?: number;
    onDelta?: (snapshot: string) => Promise<void> | void;
    signal?: AbortSignal;
    effort?: LlmEffort;
  }): Promise<LlmResult>;
  /** Present on the fallback client only. Read-only; used by /status. */
  state?(): LlmProviderState;
}

export interface ResponseStreamEvent {
  type: string;
  delta?: string;
  output_text?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number } | null;
  errorMessage?: string;
}

export interface RequestOptions {
  timeout?: number;
  signal?: AbortSignal;
}

export interface ResponseStreamCreate {
  (body: Record<string, unknown>, options?: RequestOptions): AsyncIterable<ResponseStreamEvent>;
}

export interface ResponseCreate {
  (body: Record<string, unknown>, options?: RequestOptions): Promise<{
    output_text?: string | null;
    usage?: { input_tokens?: number; output_tokens?: number } | null;
    output?: unknown;
  }>;
}

function functionCallsFrom(output: unknown): ToolCall[] {
  if (!Array.isArray(output)) return [];
  const calls: ToolCall[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (row.type !== "function_call") continue;
    if (typeof row.name !== "string" || typeof row.call_id !== "string") continue;
    calls.push({
      callId: row.call_id,
      name: row.name,
      arguments: typeof row.arguments === "string" ? row.arguments : "{}",
    });
  }
  return calls;
}

function statusOf(error: unknown): number {
  if (!error || typeof error !== "object" || !("status" in error)) return 0;
  const status = Number((error as { status: unknown }).status);
  return Number.isInteger(status) ? status : 0;
}

/** The SDK request options for one call. Undefined when there is nothing to set. */
function requestOptions(timeoutMs?: number, signal?: AbortSignal): RequestOptions | undefined {
  if (!timeoutMs && !signal) return undefined;
  return { ...(timeoutMs ? { timeout: timeoutMs } : {}), ...(signal ? { signal } : {}) };
}

/** A stop is reported as GenerationStoppedError, whatever the SDK threw (APIUserAbortError, AbortError). */
function stopIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new GenerationStoppedError();
}

function asGrokError(error: unknown): GrokError {
  if (error instanceof GrokError) return error;
  const status = statusOf(error);
  const retryable = status === 0 || status === 408 || status === 409 || status === 429 || status >= 500;
  const message = error instanceof Error ? error.message : "Grok request failed";
  // No HTTP status means the request never got an answer: a connection failure or a timeout.
  const kind = status === 0 || status === 408 ? "transport" : "status";
  const retryAfterMs = retryAfterFromHeaders((error as { headers?: unknown } | null)?.headers);
  return new GrokError(message, retryable, status, { kind, retryAfterMs });
}

function modelOf(body: Record<string, unknown>): string | undefined {
  return typeof body.model === "string" ? body.model : undefined;
}

export function createResilientClient(options: {
  model: string;
  create: ResponseCreate;
  stream?: ResponseStreamCreate;
  sleep?: (ms: number) => Promise<void>;
}): LlmClient {
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  async function call(
    body: Record<string, unknown>,
    expectJson: boolean,
    policy: LlmRequestPolicy = {},
  ): Promise<LlmResult> {
    const signal = policy.signal ?? currentAbortSignal();
    const attempt = async (): Promise<LlmResult> => {
      stopIfAborted(signal);
      try {
        const response = await options.create(body, requestOptions(policy.timeoutMs, signal));
        const text = response.output_text?.trim() ?? "";
        if (!text) throw new GrokError("The model returned an empty response.", true);
        if (expectJson) {
          try {
            JSON.parse(text);
          } catch {
            throw new GrokError("The model returned invalid JSON.", true);
          }
        }
        return {
          text,
          inputTokens: response.usage?.input_tokens ?? 0,
          outputTokens: response.usage?.output_tokens ?? 0,
          model: modelOf(body),
        };
      } catch (error) {
        stopIfAborted(signal);
        throw asGrokError(error);
      }
    };

    try {
      return await attempt();
    } catch (error) {
      if (error instanceof GenerationStoppedError) throw error;
      const grokError = asGrokError(error);
      if (policy.retry === false || !grokError.retryable) throw grokError;
      await sleep(400);
      return attempt();
    }
  }

  function base(system: string, user: string, images?: Array<{ mime: "image/jpeg" | "image/png"; base64: string }>, model = options.model): Record<string, unknown> {
    const userContent = images?.length
      ? [
          ...images.map((image) => ({
            type: "input_image",
            image_url: `data:${image.mime};base64,${image.base64}`,
            detail: "high",
          })),
          { type: "input_text", text: user },
        ]
      : user;
    return {
      model,
      store: false,
      input: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
    };
  }

  async function readStream(
    request: Record<string, unknown>,
    hooks: {
      expectJson: boolean;
      minIntervalMs?: number;
      onDelta?: (snapshot: string) => Promise<void> | void;
      timeoutMs?: number;
      retry?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<LlmResult> {
    const signal = hooks.signal ?? currentAbortSignal();
    const read = async (): Promise<LlmResult> => {
      stopIfAborted(signal);
      let text = "";
      let inputTokens = 0;
      let outputTokens = 0;
      const gate = createPreviewGate({
        minIntervalMs: hooks.minIntervalMs ?? 1_100,
        publish: (snapshot) => hooks.onDelta?.(snapshot),
      });
      try {
        for await (const event of options.stream!(request, requestOptions(hooks.timeoutMs, signal))) {
          if (event.type === "response.output_text.delta" && event.delta) {
            text += event.delta;
            await gate.push(text);
          } else if (event.type === "response.completed") {
            if (event.output_text?.trim()) text = event.output_text;
            inputTokens = event.usage?.input_tokens ?? inputTokens;
            outputTokens = event.usage?.output_tokens ?? outputTokens;
          } else if (event.type === "error" || event.type === "response.failed") {
            throw new GrokError(event.errorMessage || "Grok stream failed.", true);
          }
        }
      } catch (error) {
        stopIfAborted(signal);
        throw asGrokError(error);
      }
      stopIfAborted(signal);
      if (!text.trim()) throw new GrokError("The model returned an empty response.", true);
      await gate.flush();
      if (hooks.expectJson) {
        try {
          JSON.parse(text);
        } catch {
          throw new GrokError("The model returned invalid JSON.", true);
        }
      }
      return { text, inputTokens, outputTokens, model: modelOf(request) };
    };

    try {
      return await read();
    } catch (error) {
      if (error instanceof GenerationStoppedError) throw error;
      const grokError = asGrokError(error);
      if (hooks.retry === false || !grokError.retryable) throw grokError;
      await sleep(400);
      return read();
    }
  }

  return {
    completeStructured(input) {
      return call(
        {
          ...base(input.system, input.user, input.images, input.model),
          text: {
            format: {
              type: "json_schema",
              name: input.schemaName,
              strict: true,
              schema: input.schema,
            },
          },
        },
        true,
        { timeoutMs: input.timeoutMs, retry: input.retry, signal: input.signal },
      );
    },
    async streamStructured(input) {
      const request = {
        ...base(input.system, input.user, input.images, input.model),
        text: {
          format: {
            type: "json_schema",
            name: input.schemaName,
            strict: true,
            schema: input.schema,
          },
        },
      };
      if (!options.stream) {
        return call(request, true, { timeoutMs: input.timeoutMs, retry: input.retry, signal: input.signal });
      }
      return readStream({ ...request, stream: true }, {
        expectJson: true,
        minIntervalMs: input.minIntervalMs,
        onDelta: input.onDelta,
        timeoutMs: input.timeoutMs,
        retry: input.retry,
        signal: input.signal,
      });
    },
    async streamText(input) {
      const request = base(input.system, input.user, input.images);
      if (!options.stream) return call(request, false, { signal: input.signal });
      return readStream({ ...request, stream: true }, {
        expectJson: false,
        minIntervalMs: input.minIntervalMs,
        onDelta: input.onDelta,
        signal: input.signal,
      });
    },
    completeText(input) {
      const request = base(input.system, input.user, input.images);
      if (input.webSearch) request.tools = [{ type: "web_search" }];
      return call(request, false, { signal: input.signal });
    },
    async completeWithTools(input) {
      const request = input.input
        ? { model: options.model, store: false, input: input.input, tools: input.tools }
        : { ...base(input.system, input.user), tools: input.tools };
      const signal = input.signal ?? currentAbortSignal();
      const attempt = async (): Promise<AgentTurn> => {
        stopIfAborted(signal);
        try {
          const response = await options.create(request, requestOptions(undefined, signal));
          const functionCalls = functionCallsFrom(response.output);
          const text = response.output_text?.trim() ?? "";
          if (!text && functionCalls.length === 0) throw new GrokError("The model returned an empty response.", true);
          return {
            text,
            functionCalls,
            inputTokens: response.usage?.input_tokens ?? 0,
            outputTokens: response.usage?.output_tokens ?? 0,
            model: modelOf(request),
          };
        } catch (error) {
          stopIfAborted(signal);
          throw asGrokError(error);
        }
      };
      try {
        return await attempt();
      } catch (error) {
        if (error instanceof GenerationStoppedError) throw error;
        const grokError = asGrokError(error);
        if (!grokError.retryable) throw grokError;
        await sleep(400);
        return attempt();
      }
    },
  };
}
