import { describe, expect, it } from "vitest";
import type { LlmClient } from "../src/services/grok/client.js";
import { PROMPT_CASES } from "../src/services/rag/promptCases.js";
import { formatPromptRun, runRagPrompt } from "../src/services/rag/promptTest.js";

function llm(text: string, fail = false): LlmClient {
  return {
    async completeStructured() {
      throw new Error("unused");
    },
    async completeText() {
      if (fail) throw new Error("xai-secret-key request failed");
      return { text, inputTokens: 12, outputTokens: 4 };
    },
  };
}

describe("rag prompt tester", () => {
  it("includes an equipment question, a document, a fallback, a mix, and a how-to", () => {
    expect(PROMPT_CASES.map((item) => item.name)).toEqual(["ip", "document", "fallback", "mixed", "howto"]);
    expect(PROMPT_CASES.find((item) => item.name === "fallback")?.context).toBeNull();
    expect(PROMPT_CASES.find((item) => item.name === "mixed")?.context).toContain("identifier");
  });

  it("prints the answer, whether context was used, and token counts", async () => {
    const ip = PROMPT_CASES[0];
    if (!ip) throw new Error("missing case");
    const result = await runRagPrompt({
      llm: llm("The floor 2 printer is 192.168.1.10."),
      question: ip.question,
      context: ip.context,
      sourcesLine: ip.sourcesLine,
    });
    expect(result.ok).toBe(true);
    expect(result.ragUsed).toBe(true);
    expect(result.inputTokens).toBe(12);
    const printed = formatPromptRun(result, false);
    expect(printed).toContain("RAG context: yes");
    expect(printed).toContain("192.168.1.10");
    expect(printed).toContain("From note #14");
    expect(printed).toContain("Tokens: in=12 out=4");

    const fallback = await runRagPrompt({
      llm: llm("I don't know that. It is not in the knowledge base."),
      question: "Where is the spare keyboard?",
      context: null,
    });
    expect(fallback.ragUsed).toBe(false);
    expect(formatPromptRun(fallback, false)).toContain("From: (none)");
  });

  it("reports a failed Grok call without throwing", async () => {
    const result = await runRagPrompt({
      llm: llm("", true),
      question: "What's the IP of the floor 2 printer?",
      context: "192.168.1.10",
    });
    expect(result.ok).toBe(false);
    expect(result.error).not.toContain("xai-secret-key");
    expect(formatPromptRun(result, false)).toContain("Status: fail");
  });
});
