import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { parseEnv } from "../src/config/env.js";
import { budgetWeekStart } from "../src/services/llm/week.js";

describe("llm settings", () => {
  it("leave Claude off by default", () => {
    const env = parseEnv({});
    expect(env.ANTHROPIC_API_KEY).toBe("");
    expect(env.LLM_CLAUDE_TASKS).toEqual([]);
    expect(env.LLM_FALLBACK).toBe(false);
    expect(env.ANTHROPIC_MODEL).toBe("claude-sonnet-5-5");
    expect(env.ANTHROPIC_MODEL_FAST).toBe("claude-haiku-5-5");
  });

  it("parse a task list and reject unknown tasks", () => {
    expect(parseEnv({ LLM_CLAUDE_TASKS: " Extract, answer ,extract" }).LLM_CLAUDE_TASKS).toEqual(["extract", "answer"]);
    expect(() => parseEnv({ LLM_CLAUDE_TASKS: "extract,tools" })).toThrow();
  });

  it("leave budgets off by default and validate the week start", () => {
    const env = parseEnv({});
    expect(env.XAI_WEEKLY_TOKEN_LIMIT).toBe(0);
    expect(env.ANTHROPIC_WEEKLY_USD_LIMIT).toBe(0);
    expect(env.LLM_BUDGET_WEEK_START).toBe("mon");
    expect(env.LLM_BUDGET_DIVERT_PERCENT).toBe(90);
    expect(parseEnv({ LLM_BUDGET_WEEK_START: "fri", XAI_WEEKLY_TOKEN_LIMIT: "5000000" }).XAI_WEEKLY_TOKEN_LIMIT).toBe(5_000_000);
    expect(() => parseEnv({ LLM_BUDGET_WEEK_START: "friday" })).toThrow();
    expect(() => parseEnv({ LLM_BUDGET_DIVERT_PERCENT: "20" })).toThrow();
  });
});

describe("budget week", () => {
  const zone = "Asia/Dubai";

  it("starts on the chosen weekday at midnight in the app timezone", () => {
    // Tuesday 17 Nov 2026, 23:30 in Dubai
    const now = DateTime.fromISO("2026-11-17T23:30:00", { zone });
    expect(budgetWeekStart(now, "mon")).toBe("2026-11-15T20:00:00.000Z");
    expect(budgetWeekStart(now, "fri")).toBe("2026-11-12T20:00:00.000Z");
    expect(budgetWeekStart(now, "tue")).toBe("2026-11-16T20:00:00.000Z");
  });

  it("treats the reset day itself as the start of the new week", () => {
    const friday = DateTime.fromISO("2026-11-20T00:05:00", { zone });
    expect(budgetWeekStart(friday, "fri")).toBe("2026-11-19T20:00:00.000Z");
    const thursday = DateTime.fromISO("2026-11-19T23:59:00", { zone });
    expect(budgetWeekStart(thursday, "fri")).toBe("2026-11-12T20:00:00.000Z");
  });
});
