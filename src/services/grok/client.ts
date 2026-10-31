import { GrokError } from "../../utils/errors.js";

export interface LlmResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LlmClient {
  completeStructured(input: {
    system: string;
    user: string;
    schemaName: string;
    schema: Record<string, unknown>;
  }): Promise<LlmResult>;
  completeText(input: { system: string; user: string; webSearch?: boolean }): Promise<LlmResult>;
}

export interface ResponseCreate {
  (body: Record<string, unknown>): Promise<{
    output_text?: string | null;
    usage?: { input_tokens?: number; output_tokens?: number } | null;
  }>;
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

  function base(system: string, user: string): Record<string, unknown> {
    return {
      model: options.model,
      store: false,
      input: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    };
  }

  return {
    completeStructured(input) {
      return call(
        {
          ...base(input.system, input.user),
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
    completeText(input) {
      const request = base(input.system, input.user);
      if (input.webSearch) request.tools = [{ type: "web_search" }];
      return call(request, false);
    },
  };
}
