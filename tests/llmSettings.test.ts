import { describe, expect, it } from "vitest";
import { parseEnv } from "../src/config/env.js";

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
});
