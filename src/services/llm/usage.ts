import type { Env } from "../../config/env.js";
import { costForUsage, isClaudeModel } from "../grok/prices.js";

/**
 * The model and cost to store in ai_usage. The model is the one that ACTUALLY answered
 * (Claude when the fallback ran), not the configured primary.
 * Grok keeps the XAI_*_USD_PER_MILLION estimate it always used; Claude uses its list price.
 */
export function usageFields(
  env: Pick<Env, "XAI_INPUT_USD_PER_MILLION" | "XAI_OUTPUT_USD_PER_MILLION">,
  result: { model?: string; inputTokens: number; outputTokens: number },
  configuredModel: string,
): { model: string; estimatedUsd: number } {
  const model = result.model || configuredModel;
  if (isClaudeModel(model)) {
    return { model, estimatedUsd: costForUsage(model, result.inputTokens, result.outputTokens) ?? 0 };
  }
  return {
    model,
    estimatedUsd:
      (result.inputTokens / 1_000_000) * env.XAI_INPUT_USD_PER_MILLION +
      (result.outputTokens / 1_000_000) * env.XAI_OUTPUT_USD_PER_MILLION,
  };
}
