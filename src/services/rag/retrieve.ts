import type { Deps } from "../../app/deps.js";
import type { User } from "../../types/models.js";
import type { Reply } from "../assistant/execute.js";
import { introducedNetworkFacts } from "../../utils/security.js";
import { toIso } from "../../utils/time.js";
import { buildRagContext } from "./context.js";
import { ragConfig } from "./config.js";
import { buildRagMessages } from "./prompt.js";
import { hybridSearch } from "./search.js";
import { MemoryService } from "../memory/service.js";
import { redactString } from "../../utils/text.js";

const QUESTION = /^(?:what|where|who|when|why|how|which|whose|is|are|do|does|did|can|could|should|tell me|explain)\b/i;

/** Questions only. Commands such as "show tasks" are handled before this is called. */
export function looksLikeQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (/\?\s*$/.test(trimmed)) return true;
  return QUESTION.test(trimmed.replace(/[.?!]+$/, ""));
}

/** Search, build context, ask Grok, and return the answer with a Sources line. Null means use the normal Grok path. */
export async function answerWithRag(
  deps: Deps,
  user: User,
  question: string,
  onPreview?: (plainText: string) => Promise<void>,
): Promise<Reply | null> {
  try {
    if (onPreview) await onPreview("Searching…");
    const hits = await hybridSearch(deps, user.id, question);
    const memories = await new MemoryService(deps).promptBlock(user.id, question);
    const config = ragConfig(deps.env);
    const built = buildRagContext(deps.logger, hits, question, { maxTokens: config.contextTokens, minScore: config.minScore });
    if (!built.relevant && !memories.text) {
      deps.logger.info({ event: "rag_fallback", chunks: 0 }, "rag fallback");
      return null;
    }

    deps.logger.info({ event: "rag_used", chunks: built.chunks }, `rag used (${built.chunks} chunks)`);
    deps.logger.info(
      { event: "message_route", route: "rag_search", chunks: built.chunks },
      `rag_search (${built.chunks} chunks)`,
    );
    deps.logger.info({ event: "rag_retrieval", chunks: built.chunks }, "retrieved knowledge chunks");
    const sourcesLine = [built.relevant ? built.sourcesLine : "", memorySources(memories.numbers)].filter(Boolean).join("\n");
    const grounded = [memories.text, built.relevant ? built.context : ""].filter(Boolean).join("\n");
    if (!deps.llm) return { text: withSources(grounded, sourcesLine) };

    const prompt = buildRagMessages(question, built.relevant ? built.context : "", { sourcesLine, memories: memories.text });
    const [systemMessage, userMessage] = prompt.messages;
    const system = systemMessage?.content ?? prompt.system;
    const userText = userMessage?.content ?? prompt.user;
    const result = deps.llm.streamText
      ? await deps.llm.streamText({
          system,
          user: userText,
          minIntervalMs: deps.env.TELEGRAM_EDIT_INTERVAL_MS,
        })
      : await deps.llm.completeText({ system, user: userText });
    await deps.db.recordUsage({
      userId: user.id,
      model: deps.env.XAI_MODEL,
      purpose: "rag",
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      estimatedUsd:
        (result.inputTokens / 1_000_000) * deps.env.XAI_INPUT_USD_PER_MILLION +
        (result.outputTokens / 1_000_000) * deps.env.XAI_OUTPUT_USD_PER_MILLION,
      createdAt: toIso(deps.clock.now()),
    }).catch(() => undefined);

    const answer = result.text.trim();
    if (!answer || /^(?:i\s+(?:don't|do not)\s+know(?:\s+that)?|(?:there\s+is\s+)?no\s+information(?:\s+available)?|(?:this\s+is\s+)?not\s+in\s+the\s+(?:retrieved\s+)?records|not\s+in\s+the\s+knowledge\s+base)[.!]?$/i.test(answer)) {
      return { text: "I don't know that from your notes and documents." };
    }
    if (introducedNetworkFacts(grounded, answer).length > 0) {
      return { text: "I don't know that from your notes and documents." };
    }
    return { text: withSources(answer, sourcesLine) };
  } catch (error) {
    deps.logger.warn(
      { event: "rag_answer_failed", message: redactString(error instanceof Error ? error.message : "rag failed") },
      "falling back from RAG",
    );
    deps.logger.info({ event: "rag_fallback", chunks: 0 }, "rag fallback");
    return null;
  }
}

export const answerFromKnowledge = answerWithRag;

function memorySources(numbers: number[]): string {
  if (numbers.length === 0) return "";
  if (numbers.length === 1) return `From memory #${numbers[0]}`;
  return `From memory #${numbers.slice(0, -1).join(", #")} and memory #${numbers[numbers.length - 1]}`;
}

function withSources(answer: string, sourcesLine: string): string {
  if (!sourcesLine) return answer;
  return `${answer}\n\n${sourcesLine}`;
}
