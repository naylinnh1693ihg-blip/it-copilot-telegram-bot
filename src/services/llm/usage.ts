import type { LlmResult } from "../grok/client.js";

interface XaiRates {
  XAI_INPUT_USD_PER_MILLION: number;
  XAI_OUTPUT_USD_PER_MILLION: number;
}

/**
 * Cost to record for one model call. A result that names its own model (Claude) carries its own cost,
 * or 0 when that model has no listed price. A result without a model is priced with the xAI rates from env.
 */
export function usageUsd(
  result: Pick<LlmResult, "inputTokens" | "outputTokens" | "model" | "estimatedUsd">,
  env: XaiRates,
): number {
  if (result.estimatedUsd !== undefined) return result.estimatedUsd;
  if (result.model) return 0;
  return (
    (result.inputTokens / 1_000_000) * env.XAI_INPUT_USD_PER_MILLION +
    (result.outputTokens / 1_000_000) * env.XAI_OUTPUT_USD_PER_MILLION
  );
}
