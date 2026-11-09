import OpenAI from "openai";
import { createResilientClient, type LlmClient } from "./client.js";

export function createXaiClient(options: {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}): LlmClient {
  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseUrl,
    timeout: options.timeoutMs,
    maxRetries: 0,
  });
  const llm = createResilientClient({
    model: options.model,
    create: async (body, requestOptions) => {
      const response = (await client.responses.create(body as never, requestOptions)) as {
        output_text?: string | null;
        output?: unknown;
        usage?: { input_tokens?: number; output_tokens?: number } | null;
      };
      return {
        output_text: response.output_text ?? "",
        output: response.output,
        usage: response.usage
          ? {
              input_tokens: response.usage.input_tokens,
              output_tokens: response.usage.output_tokens,
            }
          : undefined,
      };
    },
    stream: async function* (body, requestOptions) {
      const stream = (await client.responses.create({ ...body, stream: true } as never, {
        ...requestOptions,
        stream: true,
      })) as unknown as AsyncIterable<{
        type: string;
        delta?: string;
        message?: string;
        response?: {
          output_text?: string;
          usage?: { input_tokens?: number; output_tokens?: number } | null;
          error?: { message?: string } | null;
        };
      }>;
      if (!stream || typeof stream !== "object" || !(Symbol.asyncIterator in stream)) {
        throw new Error("Grok did not return a response stream.");
      }
      for await (const event of stream) {
        if (event.type === "response.output_text.delta") {
          yield { type: event.type, delta: event.delta };
        } else if (event.type === "response.completed") {
          yield {
            type: event.type,
            output_text: event.response?.output_text,
            usage: event.response?.usage
              ? {
                  input_tokens: event.response.usage.input_tokens,
                  output_tokens: event.response.usage.output_tokens,
                }
              : undefined,
          };
        } else if (event.type === "error") {
          yield { type: event.type, errorMessage: event.message };
        } else if (event.type === "response.failed") {
          yield { type: event.type, errorMessage: event.response?.error?.message || "Grok failed." };
        }
      }
    },
  });
  return {
    ...llm,
    async embed(input) {
      const response = await client.embeddings.create({
        model: input.model,
        input: input.texts,
        dimensions: input.dimensions,
        encoding_format: "float",
      });
      const ordered = [...response.data].sort((left, right) => left.index - right.index);
      return {
        vectors: ordered.map((item) => item.embedding),
        inputTokens: response.usage?.prompt_tokens ?? 0,
      };
    },
  };
}
