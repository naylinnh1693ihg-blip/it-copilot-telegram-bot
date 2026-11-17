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

/**
 * Claude prices, USD per 1 million tokens (Anthropic list prices, Nov 2026). Claude is the backup provider;
 * these rows exist so "Week cost" shows it separately. Opus and Sonnet have no long-context surcharge.
 * Claude Haiku 5.5's rate applies to prompts up to 100K tokens. claude-opus-5 and claude-opus-4-8 are here because
 * Anthropic's server-side refusal fallback can answer with them, and ai_usage records the model that answered.
 */
function flat(input: number, output: number): ModelPrice {
  return {
    inputUsdPerMillion: input,
    outputUsdPerMillion: output,
    longContextInputTokens: Number.POSITIVE_INFINITY,
    longInputUsdPerMillion: input,
    longOutputUsdPerMillion: output,
  };
}

export const CLAUDE_PRICES: Record<string, ModelPrice> = {
  "claude-opus-5-5": flat(4, 20),
  "claude-sonnet-5-5": flat(2, 10),
  "claude-haiku-5-5": {
    inputUsdPerMillion: 0.1,
    outputUsdPerMillion: 0.5,
    longContextInputTokens: 100_000,
    longInputUsdPerMillion: 0.5,
    longOutputUsdPerMillion: 2.5,
  },
  "claude-opus-5": flat(5, 25),
  "claude-opus-4-8": flat(5, 25),
};

Object.assign(MODEL_PRICES, CLAUDE_PRICES);

export function isClaudeModel(model: string): boolean {
  return model.startsWith("claude-");
}

export function costForUsage(model: string, inputTokens: number, outputTokens: number): number | null {
  const price = MODEL_PRICES[model];
  if (!price) return null;
  const long = inputTokens >= price.longContextInputTokens;
  const inputRate = long ? price.longInputUsdPerMillion : price.inputUsdPerMillion;
  const outputRate = long ? price.longOutputUsdPerMillion : price.outputUsdPerMillion;
  return (inputTokens / 1_000_000) * inputRate + (outputTokens / 1_000_000) * outputRate;
}
