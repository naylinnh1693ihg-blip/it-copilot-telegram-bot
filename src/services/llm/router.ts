import { GrokError } from "../../utils/errors.js";
import type { LlmClient } from "../grok/client.js";
import type { ClaudeTask } from "./tasks.js";

export type Provider = "xai" | "claude";

export interface FallbackInfo {
  task: ClaudeTask;
  from: Provider;
  to: Provider;
  status: number;
  message: string;
}

export interface RouterOptions {
  xai: LlmClient;
  /** fast handles extraction, standard handles answers and documents. */
  claude: { fast: LlmClient; standard: LlmClient };
  /** Tasks sent to Claude first. An empty set keeps everything on xAI. */
  tasks: ReadonlySet<ClaudeTask>;
  /**
   * When true, a provider error on a task Claude can handle is retried once on the other provider.
   * Off by default because it sends the request to a second vendor.
   */
  fallback: boolean;
  /** Estimated input tokens (characters / 4) above which a request stays on xAI. */
  maxClaudeInputTokens: number;
  onFallback?: (info: FallbackInfo) => void;
}

function estimateTokens(...parts: string[]): number {
  return Math.ceil(parts.reduce((sum, part) => sum + part.length, 0) / 4);
}

/**
 * One LlmClient that picks a provider per call.
 * - completeStructured → "extract", streamStructured → "document", streamText and completeText → "answer"
 * - web search, tool calls, and embeddings always run on xAI
 */
export function createRoutedClient(options: RouterOptions): LlmClient {
  async function route<T>(
    task: ClaudeTask | null,
    size: number,
    call: (provider: Provider) => Promise<T>,
  ): Promise<T> {
    const eligible = task !== null && size <= options.maxClaudeInputTokens;
    const primary: Provider = eligible && options.tasks.has(task) ? "claude" : "xai";
    try {
      return await call(primary);
    } catch (error) {
      if (!options.fallback || !eligible || !(error instanceof GrokError)) throw error;
      const secondary: Provider = primary === "claude" ? "xai" : "claude";
      options.onFallback?.({ task, from: primary, to: secondary, status: error.status, message: error.message });
      return call(secondary);
    }
  }

  const { xai, claude } = options;
  return {
    completeStructured(input) {
      return route("extract", estimateTokens(input.system, input.user), (provider) =>
        provider === "claude"
          ? claude.fast.completeStructured({ ...input, model: undefined })
          : xai.completeStructured(input),
      );
    },
    streamStructured: (input) =>
      route("document", estimateTokens(input.system, input.user), (provider) =>
        provider === "claude"
          ? claude.standard.streamStructured!({ ...input, model: undefined })
          : xai.streamStructured!(input),
      ),
    streamText: (input) =>
      route("answer", estimateTokens(input.system, input.user), (provider) =>
        provider === "claude" ? claude.standard.streamText!(input) : xai.streamText!(input),
      ),
    completeText(input) {
      // Web search is an xAI tool, so those calls cannot move.
      const task = input.webSearch ? null : "answer";
      return route(task, estimateTokens(input.system, input.user), (provider) =>
        provider === "claude" ? claude.standard.completeText(input) : xai.completeText(input),
      );
    },
    completeWithTools: xai.completeWithTools ? (input) => xai.completeWithTools!(input) : undefined,
    embed: xai.embed ? (input) => xai.embed!(input) : undefined,
  };
}
