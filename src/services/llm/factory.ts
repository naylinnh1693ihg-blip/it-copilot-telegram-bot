import type { LlmClient } from "../grok/client.js";
import { createXaiClient } from "../grok/xai.js";
import { createBudget, providerName, type Budget, type Provider, type UsageRow } from "./budget.js";
import { createClaudeClient } from "./claude.js";
import { createRoutedClient, type DivertInfo, type FallbackInfo } from "./router.js";
import type { ClaudeTask } from "./tasks.js";

export interface LlmEnv {
  XAI_API_KEY: string;
  XAI_BASE_URL: string;
  XAI_MODEL: string;
  XAI_TIMEOUT_MS: number;
  XAI_WEEKLY_TOKEN_LIMIT: number;
  XAI_WEEKLY_USD_LIMIT: number;
  ANTHROPIC_API_KEY: string;
  ANTHROPIC_BASE_URL: string;
  ANTHROPIC_MODEL: string;
  ANTHROPIC_MODEL_FAST: string;
  ANTHROPIC_TIMEOUT_MS: number;
  ANTHROPIC_MAX_OUTPUT_TOKENS: number;
  ANTHROPIC_MAX_INPUT_TOKENS: number;
  ANTHROPIC_MAX_WEB_SEARCHES: number;
  ANTHROPIC_WEEKLY_TOKEN_LIMIT: number;
  ANTHROPIC_WEEKLY_USD_LIMIT: number;
  LLM_CLAUDE_TASKS: ClaudeTask[];
  LLM_FALLBACK: boolean;
  LLM_BUDGET_DIVERT_PERCENT: number;
}

export interface LlmLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface LlmRuntimeOptions {
  /** Usage rows since the start of the current budget week, for all users. */
  loadUsage: () => Promise<UsageRow[]>;
  /** Sends the owner a short plain-text notice. Failures are ignored. */
  notify?: (text: string) => Promise<void> | void;
  now?: () => number;
}

export interface LlmRuntime {
  llm: LlmClient | null;
  /** Text for the weekly cost reply, or null when no budget is set. */
  budgetReport: (() => Promise<string | null>) | null;
}

/** The same notice is sent at most once in this long. */
const NOTICE_INTERVAL_MS = 6 * 60 * 60_000;

/**
 * The model client the bot runs with. Without ANTHROPIC_API_KEY this is exactly the xAI client.
 * With it, Claude is added only for the tasks in LLM_CLAUDE_TASKS (and as a fallback when LLM_FALLBACK is true).
 * Claude is added next to xAI, never instead of it: embeddings, X search, and the code interpreter need xAI.
 *
 * Optional weekly limits (XAI_WEEKLY_* and ANTHROPIC_WEEKLY_*) move work to the other provider once a
 * provider reaches LLM_BUDGET_DIVERT_PERCENT of a limit, or after it returns a 402 or 429 error.
 */
export function createLlmRuntime(env: LlmEnv, logger: LlmLogger, options: LlmRuntimeOptions): LlmRuntime {
  const xai = env.XAI_API_KEY
    ? createXaiClient({
        apiKey: env.XAI_API_KEY,
        baseUrl: env.XAI_BASE_URL,
        model: env.XAI_MODEL,
        timeoutMs: env.XAI_TIMEOUT_MS,
      })
    : null;
  const now = options.now ?? (() => Date.now());
  const budget: Budget = createBudget({
    limits: {
      xai: { tokens: env.XAI_WEEKLY_TOKEN_LIMIT, usd: env.XAI_WEEKLY_USD_LIMIT },
      claude: { tokens: env.ANTHROPIC_WEEKLY_TOKEN_LIMIT, usd: env.ANTHROPIC_WEEKLY_USD_LIMIT },
    },
    divertPercent: env.LLM_BUDGET_DIVERT_PERCENT,
    load: options.loadUsage,
    now,
  });
  // With only xAI configured there is nothing to move work to, but the weekly reply can still show the budget.
  if (!env.ANTHROPIC_API_KEY) return { llm: xai, budgetReport: () => budget.report() };
  if (!xai) {
    logger.warn({ event: "claude_needs_xai" }, "ANTHROPIC_API_KEY is set but XAI_API_KEY is empty. Claude is not used.");
    return { llm: null, budgetReport: null };
  }

  const sentAt = new Map<string, number>();
  const tell = (key: string, text: string): void => {
    const last = sentAt.get(key);
    if (last !== undefined && now() - last < NOTICE_INTERVAL_MS) return;
    sentAt.set(key, now());
    void Promise.resolve(options.notify?.(text)).catch(() => undefined);
  };
  const other = (provider: Provider): string => providerName(provider === "xai" ? "claude" : "xai");

  const shared = {
    apiKey: env.ANTHROPIC_API_KEY,
    baseUrl: env.ANTHROPIC_BASE_URL,
    timeoutMs: env.ANTHROPIC_TIMEOUT_MS,
    maxOutputTokens: env.ANTHROPIC_MAX_OUTPUT_TOKENS,
    maxWebSearches: env.ANTHROPIC_MAX_WEB_SEARCHES,
  };
  const llm = createRoutedClient({
    xai,
    claude: {
      fast: createClaudeClient({ ...shared, model: env.ANTHROPIC_MODEL_FAST }),
      standard: createClaudeClient({ ...shared, model: env.ANTHROPIC_MODEL }),
    },
    tasks: new Set(env.LLM_CLAUDE_TASKS),
    fallback: env.LLM_FALLBACK,
    maxClaudeInputTokens: env.ANTHROPIC_MAX_INPUT_TOKENS,
    avoid: async (provider) => {
      await budget.avoid(provider);
      return budget.reason(provider);
    },
    onUsage: (provider, result) => budget.record(provider, result.inputTokens + result.outputTokens, result.estimatedUsd ?? 0),
    onProviderError: (provider, error) => {
      if (budget.trip(provider, error.status)) {
        logger.warn({ event: "llm_provider_paused", provider, status: error.status }, "provider returned a quota or rate-limit error");
        tell(
          `trip:${provider}`,
          `${providerName(provider)} returned a quota or rate-limit error (HTTP ${error.status}). Work that can move goes to ${other(provider)} for a few minutes.`,
        );
      }
    },
    onDivert: (info: DivertInfo) => {
      logger.info({ event: "llm_divert", task: info.task, from: info.from, to: info.to, reason: info.reason }, "work moved to the other provider");
      if (info.reason === "budget") {
        tell(
          `budget:${info.from}`,
          `${providerName(info.from)} has used ${Math.round(budget.percentUsed(info.from))}% of its weekly limit. Work that can move goes to ${providerName(info.to)}.`,
        );
      }
    },
    onFallback: (info: FallbackInfo) => {
      logger.warn(
        { event: "llm_fallback", task: info.task, from: info.from, to: info.to, status: info.status },
        "model call failed, retrying on the other provider",
      );
      tell(
        `fallback:${info.from}`,
        `${providerName(info.from)} failed${info.status ? ` (HTTP ${info.status})` : ""}. That request was retried on ${providerName(info.to)}.`,
      );
    },
  });
  logger.info(
    { event: "llm_providers", claudeTasks: env.LLM_CLAUDE_TASKS, fallback: env.LLM_FALLBACK, divertPercent: env.LLM_BUDGET_DIVERT_PERCENT },
    "Claude is available next to xAI",
  );
  return { llm, budgetReport: () => budget.report() };
}
