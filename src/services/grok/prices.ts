/**
 * List prices in USD per 1 million tokens.
 * Short-context rates apply until a request's input reaches longContextInputTokens.
 * At that point the long-context rates apply to every token in that request.
 * Cached-input discounts are not stored, so they are not applied.
 * Source: https://docs.x.ai/developers/pricing (10 Oct 2026).
 * grok-4.7 matches the default XAI_INPUT_USD_PER_MILLION / XAI_OUTPUT_USD_PER_MILLION.
 * grok-4.20 and grok-4.3 are priced here, not with the grok-4.7 rate.
 */
export interface ModelPrice {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  longContextInputTokens: number;
  longInputUsdPerMillion: number;
  longOutputUsdPerMillion: number;
}

const STANDARD: ModelPrice = {
  inputUsdPerMillion: 2,
  outputUsdPerMillion: 6,
  longContextInputTokens: 200_000,
  longInputUsdPerMillion: 4,
  longOutputUsdPerMillion: 12,
};

const LONG_CONTEXT: ModelPrice = {
  inputUsdPerMillion: 1.25,
  outputUsdPerMillion: 2.5,
  longContextInputTokens: 200_000,
  longInputUsdPerMillion: 2.5,
  longOutputUsdPerMillion: 5,
};

export const MODEL_PRICES: Record<string, ModelPrice> = {
  "grok-4.7": STANDARD,
  "grok-4.6": STANDARD,
  "grok-4.5": STANDARD,
  "grok-4.3": LONG_CONTEXT,
  "grok-4.20": LONG_CONTEXT,
  "grok-4.20-0309-reasoning": LONG_CONTEXT,
  "grok-4.20-0309-non-reasoning": LONG_CONTEXT,
  "grok-4.20-multi-agent-0309": LONG_CONTEXT,
};

export function costForUsage(model: string, inputTokens: number, outputTokens: number): number | null {
  const price = MODEL_PRICES[model];
  if (!price) return null;
  const long = inputTokens >= price.longContextInputTokens;
  const inputRate = long ? price.longInputUsdPerMillion : price.inputUsdPerMillion;
  const outputRate = long ? price.longOutputUsdPerMillion : price.outputUsdPerMillion;
  return (inputTokens / 1_000_000) * inputRate + (outputTokens / 1_000_000) * outputRate;
}
