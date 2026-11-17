import type { LlmClient } from "../grok/client.js";
import { createXaiClient } from "../grok/xai.js";
import { createClaudeClient } from "./claude.js";
import { createRoutedClient, type FallbackInfo } from "./router.js";
import type { ClaudeTask } from "./tasks.js";

export interface LlmEnv {
  XAI_API_KEY: string;
  XAI_BASE_URL: string;
  XAI_MODEL: string;
  XAI_TIMEOUT_MS: number;
  ANTHROPIC_API_KEY: string;
  ANTHROPIC_BASE_URL: string;
  ANTHROPIC_MODEL: string;
  ANTHROPIC_MODEL_FAST: string;
  ANTHROPIC_TIMEOUT_MS: number;
  ANTHROPIC_MAX_OUTPUT_TOKENS: number;
  ANTHROPIC_MAX_INPUT_TOKENS: number;
  LLM_CLAUDE_TASKS: ClaudeTask[];
  LLM_FALLBACK: boolean;
}

export interface LlmLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

/**
 * The model client the bot runs with. Without ANTHROPIC_API_KEY this is exactly the xAI client.
 * With it, Claude is added only for the tasks in LLM_CLAUDE_TASKS (and as a fallback when LLM_FALLBACK is true).
 * Claude is added next to xAI, never instead of it: embeddings, web search, and tools need xAI.
 */
export function createLlmClient(env: LlmEnv, logger: LlmLogger): LlmClient | null {
  const xai = env.XAI_API_KEY
    ? createXaiClient({
        apiKey: env.XAI_API_KEY,
        baseUrl: env.XAI_BASE_URL,
        model: env.XAI_MODEL,
        timeoutMs: env.XAI_TIMEOUT_MS,
      })
    : null;
  if (!env.ANTHROPIC_API_KEY) return xai;
  if (!xai) {
    logger.warn({ event: "claude_needs_xai" }, "ANTHROPIC_API_KEY is set but XAI_API_KEY is empty. Claude is not used.");
    return null;
  }

  const shared = {
    apiKey: env.ANTHROPIC_API_KEY,
    baseUrl: env.ANTHROPIC_BASE_URL,
    timeoutMs: env.ANTHROPIC_TIMEOUT_MS,
    maxOutputTokens: env.ANTHROPIC_MAX_OUTPUT_TOKENS,
  };
  const client = createRoutedClient({
    xai,
    claude: {
      fast: createClaudeClient({ ...shared, model: env.ANTHROPIC_MODEL_FAST }),
      standard: createClaudeClient({ ...shared, model: env.ANTHROPIC_MODEL }),
    },
    tasks: new Set(env.LLM_CLAUDE_TASKS),
    fallback: env.LLM_FALLBACK,
    maxClaudeInputTokens: env.ANTHROPIC_MAX_INPUT_TOKENS,
    onFallback: (info: FallbackInfo) =>
      logger.warn(
        { event: "llm_fallback", task: info.task, from: info.from, to: info.to, status: info.status },
        "model call failed, retrying on the other provider",
      ),
  });
  logger.info(
    { event: "llm_providers", claudeTasks: env.LLM_CLAUDE_TASKS, fallback: env.LLM_FALLBACK },
    "Claude is available next to xAI",
  );
  return client;
}
