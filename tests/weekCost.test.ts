import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import type { LlmClient } from "../src/services/grok/client.js";
import { handleText } from "../src/services/assistant/handleText.js";
import { formatWeekCost } from "../src/services/assistant/weekCost.js";
import { parseLocalIntent } from "../src/services/assistant/localIntent.js";
import { toIso } from "../src/utils/time.js";
import { NOW, owner, testDeps } from "./helpers.js";

function throwingLlm(): LlmClient {
  return {
    async completeStructured() {
      throw new Error("Grok should not run");
    },
    async completeText() {
      throw new Error("Grok should not run");
    },
    async completeWithTools() {
      throw new Error("Grok should not run");
    },
  };
}

describe("week cost", () => {
  it("recognizes the local phrases", () => {
    for (const phrase of [
      "Week cost",
      "This week's cost",
      "AI cost this week",
      "How much did I spend this week",
      "Usage cost this week",
    ]) {
      expect(parseLocalIntent(phrase)).toMatchObject({ intent: "help", tags: "week_cost" });
    }
    expect(parseLocalIntent("help")).toMatchObject({ intent: "help", tags: "" });
  });

  it("prices grok-4.7 and the long-context model separately, without Grok", async () => {
    const { deps, db } = testDeps();
    deps.llm = throwingLlm();
    const events: string[] = [];
    deps.logger = {
      info(obj) {
        events.push(String(obj.intent));
      },
      warn() {},
      error() {},
      debug() {},
    };
    const user = await owner(db);
    await db.recordUsage({
      userId: user.id,
      model: "grok-4.7",
      purpose: "intent",
      inputTokens: 12_400,
      outputTokens: 3_100,
      estimatedUsd: 99,
      createdAt: NOW,
    });
    await db.recordUsage({
      userId: user.id,
      model: "grok-4.20",
      purpose: "document_analysis",
      inputTokens: 48_200,
      outputTokens: 1_900,
      estimatedUsd: 99,
      createdAt: NOW,
    });
    await db.recordUsage({
      userId: user.id,
      model: "grok-4.20",
      purpose: "document_analysis",
      inputTokens: 200_000,
      outputTokens: 0,
      estimatedUsd: 99,
      createdAt: NOW,
    });

    const reply = await handleText(deps, user, "Week cost");
    expect(reply.text).toContain("AI cost this week:");
    expect(reply.text).toContain("grok-4.7: $0.04 (12.4k in / 3.1k out)");
    // 48.2k is short-context ($1.25 / $2.50). The 200k request uses the long-context rate ($2.50 in).
    expect(reply.text).toContain("grok-4.20: $0.57 (248.2k in / 1.9k out)");
    expect(reply.text).toContain("Total: $0.61");
    expect(events).toContain("week_cost");
  });

  it("says when the week is empty and marks an unknown model", async () => {
    const { deps, db } = testDeps();
    deps.llm = throwingLlm();
    const user = await owner(db);
    const empty = await handleText(deps, user, "How much did I spend this week?");
    expect(empty.text).toBe("No AI usage recorded this week.");

    await db.recordUsage({
      userId: user.id,
      model: "custom-model",
      purpose: "intent",
      inputTokens: 500,
      outputTokens: 20,
      estimatedUsd: 1,
      createdAt: NOW,
    });
    const unknown = await handleText(deps, user, "Usage cost this week");
    expect(unknown.text).toContain("Total: price unknown");
    expect(unknown.text).toContain("custom-model: price unknown (500 in / 20 out)");
  });

  it("prices Claude models next to Grok instead of marking them unknown", () => {
    const text = formatWeekCost([
      { model: "claude-sonnet-5-5", inputTokens: 1_000_000, outputTokens: 100_000 },
      { model: "grok-4.7", inputTokens: 1_000_000, outputTokens: 0 },
    ]);
    expect(text).toContain("claude-sonnet-5-5: $3.00");
    expect(text).toContain("grok-4.7: $2.00");
    expect(text).toContain("Total: $5.00");
    expect(text.includes("price unknown")).toBe(false);
  });

  it("adds the provider budget report to the weekly reply when one is set", async () => {
    const { deps, db } = testDeps();
    deps.llm = throwingLlm();
    deps.llmBudgetReport = async () => "Provider budgets this week:\nGrok: 1M of 5M tokens (20%)";
    const user = await owner(db);
    const reply = await handleText(deps, user, "How much did I spend this week?");
    expect(reply.text).toContain("No AI usage recorded this week.");
    expect(reply.text).toContain("Grok: 1M of 5M tokens (20%)");
  });

  it("totals usage for every user, including rows with no user", async () => {
    const { db } = testDeps();
    const user = await owner(db);
    const at = (iso: string) => iso;
    await db.recordUsage({ userId: user.id, model: "grok-4.7", purpose: "intent", inputTokens: 10, outputTokens: 5, estimatedUsd: 0.1, createdAt: at("2026-11-17T10:00:00.000Z") });
    await db.recordUsage({ userId: null, model: "v1", purpose: "embedding", inputTokens: 7, outputTokens: 0, estimatedUsd: 0, createdAt: at("2026-11-17T11:00:00.000Z") });
    await db.recordUsage({ userId: user.id, model: "grok-4.7", purpose: "intent", inputTokens: 99, outputTokens: 99, estimatedUsd: 9, createdAt: at("2026-11-01T00:00:00.000Z") });
    const totals = await db.usageTotalsSince("2026-11-15T00:00:00.000Z");
    expect(totals).toHaveLength(2);
    expect(totals.map((row) => row.model).sort()).toEqual(["grok-4.7", "v1"]);
  });

  it("uses Monday-to-Monday in the user timezone", async () => {
    const { deps, db } = testDeps();
    deps.llm = throwingLlm();
    const user = await owner(db);
    const now = DateTime.fromISO(NOW);
    const monday = now.startOf("day").minus({ days: now.weekday - 1 });
    await db.recordUsage({
      userId: user.id,
      model: "grok-4.7",
      purpose: "intent",
      inputTokens: 100_000,
      outputTokens: 0,
      estimatedUsd: 0,
      createdAt: toIso(monday.minus({ seconds: 1 })),
    });
    await db.recordUsage({
      userId: user.id,
      model: "grok-4.7",
      purpose: "intent",
      inputTokens: 100_000,
      outputTokens: 0,
      estimatedUsd: 0,
      createdAt: toIso(monday.plus({ seconds: 1 })),
    });
    await db.recordUsage({
      userId: user.id,
      model: "grok-4.7",
      purpose: "intent",
      inputTokens: 100_000,
      outputTokens: 0,
      estimatedUsd: 0,
      createdAt: toIso(monday.plus({ weeks: 1 })),
    });

    const reply = await handleText(deps, user, "This week's cost");
    expect(reply.text).toContain("Total: $0.20");
    expect(reply.text).toContain("grok-4.7: $0.20 (100k in / 0 out)");
  });
});
