import type { Deps } from "../../app/deps.js";
import type { User } from "../../types/models.js";
import type { Reply } from "../assistant/execute.js";
import { introducedNetworkFacts } from "../../utils/security.js";
import { toIso } from "../../utils/time.js";
import { buildRagContext } from "./context.js";
import { ragConfig } from "./config.js";
import { buildRagMessages } from "./prompt.js";
import { hybridSearch } from "./search.js";
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
    const hits = await hybridSearch(deps, user.id, question);
    const config = ragConfig(deps.env);
    const built = buildRagContext(deps.logger, hits, question, { maxTokens: config.contextTokens, minScore: config.minScore });
    if (!built.relevant) {
      deps.logger.info({ event: "rag_fallback", chunks: 0 }, "rag fallback");
      return null;
    }

    deps.logger.info({ event: "rag_used", chunks: built.chunks }, `rag used (${built.chunks} chunks)`);
    deps.logger.info(
      { event: "message_route", route: "rag_search", chunks: built.chunks },
      `rag_search (${built.chunks} chunks)`,
    );
    deps.logger.info({ event: "rag_retrieval", chunks: built.chunks }, "retrieved knowledge chunks");
    if (!deps.llm) return { text: withSources(built.context, built.sourcesLine) };

    const prompt = buildRagMessages(question, built.context, { sourcesLine: built.sourcesLine });
    const [systemMessage, userMessage] = prompt.messages;
    const system = systemMessage?.content ?? prompt.system;
    const userText = userMessage?.content ?? prompt.user;
    if (onPreview) await onPreview("Searching…");
    const result = deps.llm.streamText
      ? await deps.llm.streamText({
          system,
          user: userText,
          minIntervalMs: deps.env.TELEGRAM_EDIT_INTERVAL_MS,
          onDelta: onPreview,
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
    if (!answer || /don'?t know|not in the (retrieved )?records|no information|not in the knowledge base/i.test(answer)) {
      return { text: "I don't know that from your notes and documents." };
    }
    if (introducedNetworkFacts(built.context, answer).length > 0) {
      return { text: "I don't know that from your notes and documents." };
    }
    return { text: withSources(answer, built.sourcesLine) };
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

function withSources(answer: string, sourcesLine: string): string {
  if (!sourcesLine) return answer;
  return `${answer}\n\n${sourcesLine}`;
}
