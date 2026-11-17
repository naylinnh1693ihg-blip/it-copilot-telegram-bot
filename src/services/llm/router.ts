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
 * - completeText with web search → "web"
 * - completeWithTools → "tools" when every tool is one of the bot's own functions
 * - a request that uses xAI's X search or code interpreter, and every embedding, always runs on xAI
 */
export function createRoutedClient(options: RouterOptions): LlmClient {
  async function route<T>(
    task: ClaudeTask | null,
    size: number,
    call: (provider: Provider) => Promise<T>,
    canFallback = true,
  ): Promise<T> {
    const eligible = task !== null && size <= options.maxClaudeInputTokens;
    const primary: Provider = eligible && options.tasks.has(task) ? "claude" : "xai";
    try {
      return await call(primary);
    } catch (error) {
      if (!options.fallback || !canFallback || !eligible || !(error instanceof GrokError)) throw error;
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
      return route(input.webSearch ? "web" : "answer", estimateTokens(input.system, input.user), (provider) =>
        provider === "claude" ? claude.standard.completeText(input) : xai.completeText(input),
      );
    },
    completeWithTools: xai.completeWithTools
      ? (input) => {
          // Only the bot's own function tools can run on Claude. Built-in tools (X search, code interpreter) are xAI's.
          const ownTools = input.tools.every((tool) => tool.type === "function");
          // Follow-up rounds carry the provider's call ids, so a loop that started on one provider stays there.
          const firstRound = input.input === undefined;
          return route(
            ownTools ? "tools" : null,
            estimateTokens(input.system, input.user),
            (provider) =>
              provider === "claude" ? claude.standard.completeWithTools!(input) : xai.completeWithTools!(input),
            firstRound,
          );
        }
      : undefined,
    embed: xai.embed ? (input) => xai.embed!(input) : undefined,
  };
}
