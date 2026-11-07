import type { Env } from "../../config/env.js";

/**
 * Document-analysis model routing, by estimated tokens (characters / 4):
 * - under standardTokenLimit (default 120_000) → standardModel, grok-4.7
 * - through longTokenLimit (default 400_000) → longModel, grok-4.20
 * - above that → maxModel, then keep the start and end of the text and warn
 * Override the names and cutoffs with XAI_MODEL, XAI_MODEL_LONG, XAI_MODEL_MAX,
 * XAI_ANALYSIS_STANDARD_TOKENS, and XAI_ANALYSIS_LONG_TOKENS.
 */
export const ANALYSIS_MODEL_DEFAULTS = {
  standardModel: "grok-4.7",
  longModel: "grok-4.20",
  maxModel: "grok-4.20",
  standardTokenLimit: 120_000,
  longTokenLimit: 400_000,
} as const;

export interface AnalysisModelConfig {
  standardModel: string;
  longModel: string;
  maxModel: string;
  standardTokenLimit: number;
  longTokenLimit: number;
}

export interface AnalysisRoute {
  model: string;
  estimatedTokens: number;
  truncated: boolean;
  text: string;
}

export function estimateDocumentTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function analysisModelConfig(env: Pick<Env, "XAI_MODEL" | "XAI_MODEL_LONG" | "XAI_MODEL_MAX" | "XAI_ANALYSIS_STANDARD_TOKENS" | "XAI_ANALYSIS_LONG_TOKENS">): AnalysisModelConfig {
  const standardTokenLimit = env.XAI_ANALYSIS_STANDARD_TOKENS;
  const longTokenLimit = Math.max(env.XAI_ANALYSIS_LONG_TOKENS, standardTokenLimit);
  return {
    standardModel: env.XAI_MODEL || ANALYSIS_MODEL_DEFAULTS.standardModel,
    longModel: env.XAI_MODEL_LONG || ANALYSIS_MODEL_DEFAULTS.longModel,
    maxModel: env.XAI_MODEL_MAX || ANALYSIS_MODEL_DEFAULTS.maxModel,
    standardTokenLimit,
    longTokenLimit,
  };
}

export function maxAnalysisChars(config: AnalysisModelConfig): number {
  return config.longTokenLimit * 4;
}

export function chooseAnalysisModel(text: string, config: AnalysisModelConfig): {
  model: string;
  estimatedTokens: number;
  truncateToChars: number | null;
} {
  const estimatedTokens = estimateDocumentTokens(text);
  if (estimatedTokens < config.standardTokenLimit) {
    return { model: config.standardModel, estimatedTokens, truncateToChars: null };
  }
  if (estimatedTokens <= config.longTokenLimit) {
    return { model: config.longModel, estimatedTokens, truncateToChars: null };
  }
  return { model: config.maxModel, estimatedTokens, truncateToChars: maxAnalysisChars(config) };
}
