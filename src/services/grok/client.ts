import { GrokError } from "../../utils/errors.js";
import { createPreviewGate } from "./streamPreview.js";

export interface LlmResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
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
  }): Promise<LlmResult>;
  completeText(input: {
    system: string;
    user: string;
    webSearch?: boolean;
    images?: Array<{ mime: "image/jpeg" | "image/png"; base64: string }>;
  }): Promise<LlmResult>;
  completeWithTools?(input: {
    system: string;
    user: string;
    tools: Array<Record<string, unknown>>;
    /** Full Responses API input for a follow-up turn. The first turn builds input from system and user. */
    input?: unknown[];
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
  }): Promise<LlmResult>;
  /** Plain-text stream. Previews are throttled. The returned text is the full answer. */
  streamText?(input: {
    system: string;
    user: string;
    images?: Array<{ mime: "image/jpeg" | "image/png"; base64: string }>;
    minIntervalMs?: number;
    onDelta?: (snapshot: string) => Promise<void> | void;
  }): Promise<LlmResult>;
}

export interface ResponseStreamEvent {
  type: string;
  delta?: string;
  output_text?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number } | null;
  errorMessage?: string;
}

export interface ResponseStreamCreate {
  (body: Record<string, unknown>): AsyncIterable<ResponseStreamEvent>;
}

export interface ResponseCreate {
  (body: Record<string, unknown>): Promise<{
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

function asGrokError(error: unknown): GrokError {
  if (error instanceof GrokError) return error;
  const status = statusOf(error);
  const retryable = status === 0 || status === 408 || status === 409 || status === 429 || status >= 500;
  const message = error instanceof Error ? error.message : "Grok request failed";
  return new GrokError(message, retryable, status);
}

export function createResilientClient(options: {
  model: string;
  create: ResponseCreate;
  stream?: ResponseStreamCreate;
  sleep?: (ms: number) => Promise<void>;
}): LlmClient {
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  async function call(body: Record<string, unknown>, expectJson: boolean): Promise<LlmResult> {
    const attempt = async (): Promise<LlmResult> => {
      try {
        const response = await options.create(body);
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
        };
      } catch (error) {
        throw asGrokError(error);
      }
    };

    try {
      return await attempt();
    } catch (error) {
      const grokError = asGrokError(error);
      if (!grokError.retryable) throw grokError;
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
    hooks: { expectJson: boolean; minIntervalMs?: number; onDelta?: (snapshot: string) => Promise<void> | void },
  ): Promise<LlmResult> {
    const read = async (): Promise<LlmResult> => {
      let text = "";
      let inputTokens = 0;
      let outputTokens = 0;
      const gate = createPreviewGate({
        minIntervalMs: hooks.minIntervalMs ?? 1_100,
        publish: (snapshot) => hooks.onDelta?.(snapshot),
      });
      try {
        for await (const event of options.stream!(request)) {
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
        throw asGrokError(error);
      }
      if (!text.trim()) throw new GrokError("The model returned an empty response.", true);
      await gate.flush();
      if (hooks.expectJson) {
        try {
          JSON.parse(text);
        } catch {
          throw new GrokError("The model returned invalid JSON.", true);
        }
      }
      return { text, inputTokens, outputTokens };
    };

    try {
      return await read();
    } catch (error) {
      const grokError = asGrokError(error);
      if (!grokError.retryable) throw grokError;
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
      if (!options.stream) return call(request, true);
      return readStream({ ...request, stream: true }, {
        expectJson: true,
        minIntervalMs: input.minIntervalMs,
        onDelta: input.onDelta,
      });
    },
    async streamText(input) {
      const request = base(input.system, input.user, input.images);
      if (!options.stream) return call(request, false);
      return readStream({ ...request, stream: true }, {
        expectJson: false,
        minIntervalMs: input.minIntervalMs,
        onDelta: input.onDelta,
      });
    },
    completeText(input) {
      const request = base(input.system, input.user, input.images);
      if (input.webSearch) request.tools = [{ type: "web_search" }];
      return call(request, false);
    },
    async completeWithTools(input) {
      const request = input.input
        ? { model: options.model, store: false, input: input.input, tools: input.tools }
        : { ...base(input.system, input.user), tools: input.tools };
      const attempt = async (): Promise<AgentTurn> => {
        try {
          const response = await options.create(request);
          const functionCalls = functionCallsFrom(response.output);
          const text = response.output_text?.trim() ?? "";
          if (!text && functionCalls.length === 0) throw new GrokError("The model returned an empty response.", true);
          return {
            text,
            functionCalls,
            inputTokens: response.usage?.input_tokens ?? 0,
            outputTokens: response.usage?.output_tokens ?? 0,
          };
        } catch (error) {
          throw asGrokError(error);
        }
      };
      try {
        return await attempt();
      } catch (error) {
        const grokError = asGrokError(error);
        if (!grokError.retryable) throw grokError;
        await sleep(400);
        return attempt();
      }
    },
  };
}
