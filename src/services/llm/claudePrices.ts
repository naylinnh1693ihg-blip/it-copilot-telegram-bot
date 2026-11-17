/**
 * List prices in USD per 1 million tokens for the Claude API.
 * Source: Anthropic's published rates as reported on 8 Oct 2026. Check
 * https://platform.claude.com/docs/en/about-claude/pricing before relying on them.
 * Prompt-cache discounts are not applied. This adapter does not use caching.
 * Haiku 5.5 charges higher rates for every token of a request whose input is over 100,000 tokens.
 */
export interface ClaudePrice {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  longContextInputTokens?: number;
  longInputUsdPerMillion?: number;
  longOutputUsdPerMillion?: number;
}

export const CLAUDE_PRICES: Record<string, ClaudePrice> = {
  "claude-sonnet-5-5": { inputUsdPerMillion: 2, outputUsdPerMillion: 10 },
  "claude-opus-5-5": { inputUsdPerMillion: 4, outputUsdPerMillion: 20 },
  "claude-haiku-5-5": {
    inputUsdPerMillion: 0.1,
    outputUsdPerMillion: 0.5,
    longContextInputTokens: 100_000,
    longInputUsdPerMillion: 0.5,
    longOutputUsdPerMillion: 2.5,
  },
};

/** Returns null for a model that has no listed price. */
export function claudeCost(model: string, inputTokens: number, outputTokens: number): number | null {
  const price = CLAUDE_PRICES[model];
  if (!price) return null;
  const long = price.longContextInputTokens !== undefined && inputTokens > price.longContextInputTokens;
  const inputRate = long ? price.longInputUsdPerMillion ?? price.inputUsdPerMillion : price.inputUsdPerMillion;
  const outputRate = long ? price.longOutputUsdPerMillion ?? price.outputUsdPerMillion : price.outputUsdPerMillion;
  return (inputTokens / 1_000_000) * inputRate + (outputTokens / 1_000_000) * outputRate;
}
