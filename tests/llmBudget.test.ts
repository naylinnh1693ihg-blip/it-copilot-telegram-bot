import { describe, expect, it } from "vitest";
import { createBudget, providerOf, type UsageRow } from "../src/services/llm/budget.js";

const row = (model: string, input: number, output: number, usd = 0): UsageRow => ({
  model,
  inputTokens: input,
  outputTokens: output,
  estimatedUsd: usd,
});

function build(rows: UsageRow[], limits = { xai: { tokens: 1_000, usd: 0 }, claude: { tokens: 0, usd: 10 } }) {
  let clock = 1_000_000;
  let loads = 0;
  let fail = false;
  const budget = createBudget({
    limits,
    divertPercent: 90,
    load: async () => {
      loads += 1;
      if (fail) throw new Error("db down");
      return rows;
    },
    now: () => clock,
  });
  return {
    budget,
    advance: (ms: number) => {
      clock += ms;
    },
    loads: () => loads,
    failLoads: () => {
      fail = true;
    },
  };
}

describe("provider budget", () => {
  it("tells Claude models from everything else, including embedding models", () => {
    expect(providerOf("claude-sonnet-5-5")).toBe("claude");
    expect(providerOf("grok-4.7")).toBe("xai");
    expect(providerOf("v1")).toBe("xai");
  });

  it("avoids a provider only once it reaches the divert percent of a limit", async () => {
    const low = build([row("grok-4.7", 400, 100)]);
    expect(await low.budget.avoid("xai")).toBe(false);
    expect(low.budget.percentUsed("xai")).toBe(50);

    const high = build([row("grok-4.7", 800, 100)]);
    expect(await high.budget.avoid("xai")).toBe(true);
    expect(high.budget.reason("xai")).toBe("budget");
  });

  it("counts USD for Claude and uses the larger of the token and USD shares", async () => {
    const { budget } = build([row("claude-sonnet-5-5", 100, 100, 9.5)]);
    expect(await budget.avoid("claude")).toBe(true);
    expect(Math.round(budget.percentUsed("claude"))).toBe(95);
  });

  it("never avoids a provider with no limit", async () => {
    const { budget } = build([row("grok-4.7", 9_000_000, 9_000_000)], { xai: { tokens: 0, usd: 0 }, claude: { tokens: 0, usd: 0 } });
    expect(await budget.avoid("xai")).toBe(false);
    expect(await budget.report()).toBe(null);
  });

  it("adds finished calls to the totals between reloads", async () => {
    const { budget, loads } = build([row("grok-4.7", 500, 0)]);
    expect(await budget.avoid("xai")).toBe(false);
    budget.record("xai", 450, 0);
    expect(await budget.avoid("xai")).toBe(true);
    expect(loads()).toBe(1);
  });

  it("reloads the totals after the cache expires", async () => {
    const { budget, advance, loads } = build([row("grok-4.7", 10, 0)]);
    await budget.avoid("xai");
    advance(30_000);
    await budget.avoid("xai");
    expect(loads()).toBe(1);
    advance(31_000);
    await budget.avoid("xai");
    expect(loads()).toBe(2);
  });

  it("pauses a provider for a few minutes after a 429 or 402, and not after other errors", async () => {
    const { budget, advance } = build([]);
    expect(budget.trip("xai", 500)).toBe(false);
    expect(budget.reason("xai")).toBe(null);
    expect(budget.trip("xai", 429)).toBe(true);
    expect(budget.reason("xai")).toBe("quota");
    expect(budget.trip("xai", 429)).toBe(false);
    advance(6 * 60_000);
    expect(budget.reason("xai")).toBe(null);
    expect(budget.trip("claude", 402)).toBe(true);
  });

  it("keeps answering when the usage read fails", async () => {
    const { budget, failLoads } = build([row("grok-4.7", 950, 0)]);
    failLoads();
    expect(await budget.avoid("xai")).toBe(false);
  });

  it("reports each limited provider", async () => {
    const { budget } = build([row("grok-4.7", 1_500_000, 500_000), row("claude-sonnet-5-5", 10, 10, 3.1)], {
      xai: { tokens: 5_000_000, usd: 0 },
      claude: { tokens: 0, usd: 10 },
    });
    const text = await budget.report();
    expect(text).toContain("Grok: 2M of 5M tokens (40%)");
    expect(text).toContain("Claude: $3.10 of $10.00 (31%)");
  });
});
