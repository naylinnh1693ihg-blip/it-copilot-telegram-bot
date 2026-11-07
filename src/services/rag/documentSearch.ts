import type { Deps } from "../../app/deps.js";
import type { User } from "../../types/models.js";
import { snippet } from "../../utils/text.js";
import { hybridSearch, type KnowledgeMatch } from "./search.js";

/** Hybrid search limited to document chunks, one snippet per document. */
export async function searchDocumentContent(deps: Deps, user: User, query: string): Promise<string> {
  const trimmed = query.trim();
  if (!trimmed) return "What should I look for in your documents?";
  const matches = await hybridSearch(deps, user.id, trimmed, 8);
  const documents = bestPerDocument(matches.filter((hit) => hit.sourceType === "document")).slice(0, 6);
  deps.logger.info({ event: "document_search", queryLength: trimmed.length, matches: documents.length }, "document search");
  if (documents.length === 0) return `I don't have a document that mentions "${trimmed}".`;
  const lines = documents.map((hit, index) => `${index + 1}. ${hit.title} — “${snippet(hit.content, 90)}”`);
  return `Found in documents:\n${lines.join("\n")}`;
}

function bestPerDocument(hits: KnowledgeMatch[]): KnowledgeMatch[] {
  const kept: KnowledgeMatch[] = [];
  for (const hit of hits) {
    const index = kept.findIndex((existing) => existing.sourceId === hit.sourceId || existing.sourceNumber === hit.sourceNumber);
    if (index === -1) kept.push(hit);
    else if (hit.score > (kept[index]?.score ?? 0)) kept[index] = hit;
  }
  return kept;
}
