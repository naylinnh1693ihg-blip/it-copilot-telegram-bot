import type { LlmClient } from "../grok/client.js";
import { redactString } from "../../utils/text.js";
import { buildRagMessages, type AnswerStyle, type GrokMessage } from "./prompt.js";

export interface PromptRunResult {
  question: string;
  ragUsed: boolean;
  answer: string;
  sourcesLine: string;
  inputTokens: number;
  outputTokens: number;
  ok: boolean;
  error: string;
  messages: GrokMessage[];
}

/** Build the prompt and ask Grok. An empty context uses fallback mode and does not throw. */
export async function runRagPrompt(input: {
  llm: LlmClient;
  question: string;
  context: string | null;
  sourcesLine?: string;
  style?: AnswerStyle;
}): Promise<PromptRunResult> {
  const prompt = buildRagMessages(input.question, input.context, {
    style: input.style ?? "normal",
    sourcesLine: input.sourcesLine,
  });
  const base = {
    question: input.question.trim(),
    ragUsed: prompt.mode === "rag",
    sourcesLine: prompt.sourcesLine,
    messages: prompt.messages,
    inputTokens: 0,
    outputTokens: 0,
  };
  try {
    const result = await input.llm.completeText({ system: prompt.system, user: prompt.user });
    return {
      ...base,
      answer: result.text.trim(),
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      ok: true,
      error: "",
    };
  } catch (error) {
    return {
      ...base,
      answer: "",
      ok: false,
      error: redactString(error instanceof Error ? error.message : "Grok request failed"),
    };
  }
}

export function formatPromptRun(result: PromptRunResult, debug: boolean): string {
  const lines = [
    `Question: ${result.question}`,
    `RAG context: ${result.ragUsed ? "yes" : "no"}`,
    `Status: ${result.ok ? "ok" : "fail"}`,
    `Tokens: in=${result.inputTokens} out=${result.outputTokens}`,
    "Answer:",
    result.ok ? result.answer || "(empty)" : result.error,
    result.sourcesLine || "Sources: (none)",
  ];
  if (debug) {
    lines.push("Messages:");
    lines.push(JSON.stringify(result.messages, null, 2));
  }
  return lines.join("\n");
}
