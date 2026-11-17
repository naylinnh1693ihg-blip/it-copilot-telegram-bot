import { GrokError } from "../../utils/errors.js";
import {
  createResilientClient,
  type LlmClient,
  type LlmResult,
  type ResponseStreamEvent,
} from "../grok/client.js";
import { claudeCost } from "./claudePrices.js";

/**
 * Claude over the Anthropic Messages API, using Node's built-in fetch (no SDK dependency).
 *
 * The retry, JSON check, and streaming-preview logic is shared with the xAI client through
 * createResilientClient. This file only translates a Responses-shaped request into a Messages
 * request and the answer back, so both providers behave the same for callers.
 *
 * Supported: plain text, structured JSON, images (JPEG and PNG), streaming.
 * Not supported: tool calls, web search, embeddings. Those stay on xAI.
 */
export interface ClaudeClientOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs: number;
  maxOutputTokens: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const API_VERSION = "2023-06-01";
const DATA_URL = /^data:(image\/(?:jpeg|png));base64,([\s\S]+)$/;

type Row = Record<string, unknown>;

function isRow(value: unknown): value is Row {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function claudeError(message: string, retryable: boolean, status = 0): GrokError {
  return new GrokError(message, retryable, status, "claude");
}

function retryableStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 409 || status === 429 || status >= 500;
}

function userContent(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) throw claudeError("The request had no user content.", false);
  const blocks: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (!isRow(part)) continue;
    if (part.type === "input_text" && typeof part.text === "string") {
      blocks.push({ type: "text", text: part.text });
    } else if (part.type === "input_image" && typeof part.image_url === "string") {
      const match = DATA_URL.exec(part.image_url);
      if (!match) throw claudeError("Only JPEG and PNG images are supported.", false);
      blocks.push({ type: "image", source: { type: "base64", media_type: match[1], data: match[2] } });
    }
  }
  if (blocks.length === 0) throw claudeError("The request had no user content.", false);
  return blocks;
}

interface Translated {
  payload: Record<string, unknown>;
  structured: boolean;
}

function translate(body: Row, options: ClaudeClientOptions): Translated {
  if (body.tools !== undefined) throw claudeError("Claude does not run tools in this bot yet.", false);
  const input = Array.isArray(body.input) ? body.input.filter(isRow) : [];
  const system = input
    .filter((message) => message.role === "system" && typeof message.content === "string")
    .map((message) => message.content as string)
    .join("\n\n");
  const user = input.find((message) => message.role === "user");
  if (!user) throw claudeError("The request had no user message.", false);

  const requested = typeof body.model === "string" && body.model.startsWith("claude-") ? body.model : options.model;
  const payload: Record<string, unknown> = {
    model: requested,
    max_tokens: options.maxOutputTokens,
    messages: [{ role: "user", content: userContent(user.content) }],
  };
  if (system) payload.system = system;

  const format = isRow(body.text) && isRow(body.text.format) ? body.text.format : null;
  let structured = false;
  if (format && format.type === "json_schema") {
    const name = typeof format.name === "string" ? format.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) : "";
    const schema = format.schema;
    if (!name || !isRow(schema) || schema.type !== "object") {
      throw claudeError("A structured request needs a named object schema.", false);
    }
    payload.tools = [
      {
        name,
        description: "Return the answer by calling this tool once with the structured data. Do not reply in text.",
        input_schema: schema,
      },
    ];
    payload.tool_choice = { type: "tool", name };
    structured = true;
  }
  return { payload, structured };
}

function inputTokensOf(usage: unknown): number {
  if (!isRow(usage)) return 0;
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  return number(usage.input_tokens) + number(usage.cache_creation_input_tokens) + number(usage.cache_read_input_tokens);
}

function outputTokensOf(usage: unknown): number {
  return isRow(usage) && typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
}

function checkStopReason(reason: unknown): void {
  if (reason === "max_tokens") throw claudeError("Claude's answer was cut off at the output token limit.", false);
  if (reason === "refusal") throw claudeError("Claude declined to answer this request.", false);
}

async function errorDetail(response: Response): Promise<string> {
  try {
    const data: unknown = await response.json();
    if (isRow(data) && isRow(data.error) && typeof data.error.message === "string") {
      return data.error.message.slice(0, 300);
    }
  } catch {
    // The body was not JSON. The status code is enough.
  }
  return `HTTP ${response.status}`;
}

export function createClaudeClient(options: ClaudeClientOptions): LlmClient {
  const doFetch = options.fetch ?? fetch;
  const url = `${(options.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "")}/v1/messages`;

  async function post(payload: Record<string, unknown>, timeoutMs: number): Promise<Response> {
    let response: Response;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": options.apiKey,
          "anthropic-version": API_VERSION,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "request failed";
      throw claudeError(`Claude request failed: ${message}`, true);
    }
    if (!response.ok) {
      throw claudeError(`Claude returned ${response.status}: ${await errorDetail(response)}`, retryableStatus(response.status), response.status);
    }
    return response;
  }

  const base = createResilientClient({
    model: options.model,
    sleep: options.sleep,
    create: async (body, requestOptions) => {
      const { payload, structured } = translate(body, options);
      const response = await post(payload, requestOptions?.timeout ?? options.timeoutMs);
      const data: unknown = await response.json();
      if (!isRow(data)) throw claudeError("Claude returned an unreadable response.", true);
      checkStopReason(data.stop_reason);
      const blocks = Array.isArray(data.content) ? data.content.filter(isRow) : [];
      let text = "";
      if (structured) {
        const call = blocks.find((block) => block.type === "tool_use");
        if (call && call.input !== undefined) text = JSON.stringify(call.input);
      } else {
        text = blocks
          .filter((block) => block.type === "text" && typeof block.text === "string")
          .map((block) => block.text as string)
          .join("");
      }
      return {
        output_text: text,
        usage: { input_tokens: inputTokensOf(data.usage), output_tokens: outputTokensOf(data.usage) },
      };
    },
    stream: async function* (body, requestOptions): AsyncGenerator<ResponseStreamEvent> {
      const { payload } = translate(body, options);
      const response = await post({ ...payload, stream: true }, requestOptions?.timeout ?? options.timeoutMs);
      if (!response.body) throw claudeError("Claude did not return a response stream.", true);

      let text = "";
      let inputTokens = 0;
      let outputTokens = 0;
      let buffer = "";
      const decoder = new TextDecoder();

      function* handle(raw: string): Generator<ResponseStreamEvent> {
        const data = raw
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) return;
        let event: unknown;
        try {
          event = JSON.parse(data);
        } catch {
          return;
        }
        if (!isRow(event)) return;
        if (event.type === "message_start" && isRow(event.message)) {
          inputTokens = inputTokensOf(event.message.usage) || inputTokens;
        } else if (event.type === "content_block_delta" && isRow(event.delta)) {
          const delta =
            event.delta.type === "text_delta" && typeof event.delta.text === "string"
              ? event.delta.text
              : event.delta.type === "input_json_delta" && typeof event.delta.partial_json === "string"
                ? event.delta.partial_json
                : "";
          if (delta) {
            text += delta;
            yield { type: "response.output_text.delta", delta };
          }
        } else if (event.type === "message_delta") {
          if (isRow(event.usage)) outputTokens = outputTokensOf(event.usage) || outputTokens;
          if (isRow(event.delta)) checkStopReason(event.delta.stop_reason);
        } else if (event.type === "error") {
          const message = isRow(event.error) && typeof event.error.message === "string" ? event.error.message : "Claude stream failed.";
          const overloaded = isRow(event.error) && (event.error.type === "overloaded_error" || event.error.type === "api_error");
          throw claudeError(message.slice(0, 300), overloaded);
        }
      }

      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          yield* handle(raw);
          boundary = buffer.indexOf("\n\n");
        }
      }
      if (buffer.trim()) yield* handle(buffer);
      yield {
        type: "response.completed",
        output_text: text,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      };
    },
  });

  function label(result: LlmResult): LlmResult {
    const cost = claudeCost(options.model, result.inputTokens, result.outputTokens);
    return { ...result, model: options.model, estimatedUsd: cost ?? 0 };
  }

  return {
    async completeStructured(input) {
      return label(await base.completeStructured(input));
    },
    async completeText(input) {
      return label(await base.completeText(input));
    },
    async streamStructured(input) {
      return label(await base.streamStructured!(input));
    },
    async streamText(input) {
      return label(await base.streamText!(input));
    },
  };
}
