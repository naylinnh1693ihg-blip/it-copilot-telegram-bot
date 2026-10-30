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
  return createResilientClient({
    model: options.model,
    create: async (body) => {
      const response = await client.responses.create(body as never);
      return {
        output_text: "output_text" in response ? response.output_text : "",
        usage: response.usage
          ? {
              input_tokens: response.usage.input_tokens,
              output_tokens: response.usage.output_tokens,
            }
          : undefined,
      };
    },
  });
}
