import { describe, expect, it } from "vitest";
import type { KnowledgeMatch } from "../src/services/rag/search.js";
import { buildRagContext, buildRagPrompt } from "../src/services/rag/context.js";
import { silentLogger } from "../src/utils/logger.js";

function match(input: Partial<KnowledgeMatch> & Pick<KnowledgeMatch, "content" | "score">): KnowledgeMatch {
  return {
    sourceType: input.sourceType ?? "note",
    sourceId: input.sourceId ?? "note-1",
    sourceNumber: input.sourceNumber ?? 14,
    title: input.title ?? "Floor 2 printer",
    content: input.content,
    score: input.score,
    metadata: input.metadata ?? { chunk_type: "narrative", embedding_model: "v1" },
  };
}

describe("rag context", () => {
  it("builds a numbered context, drops duplicates and weak chunks, and keeps identifiers", () => {
    const full = `${"The closet feeds the east wing. ".repeat(40)}The printer-floor2 uses 192.168.1.10.`;
    const events: string[] = [];
    const logger = {
      info(obj: Record<string, unknown>) {
        if (obj.event === "rag_context") events.push(`${obj.chunks}:${obj.tokens}`);
      },
      warn() {},
      error() {},
      debug() {},
    };
    const built = buildRagContext(
      logger,
      [
        match({ content: full, score: 0.95 }),
        match({ content: full.slice(0, Math.floor(full.length * 0.9)), score: 0.9 }),
        match({
          content: "Switch-Core IP: 10.0.0.1",
          score: 0.8,
          sourceType: "document",
          sourceId: "doc-1",
          sourceNumber: 2,
          title: "Network-Map.pdf",
          metadata: { chunk_type: "identifier", embedding_model: "v1" },
        }),
        match({
          content: "Guest wifi password rotation notes.",
          score: 0.2,
          sourceId: "low",
          sourceNumber: 3,
          title: "Wifi",
        }),
      ],
      "What’s the IP of the floor 2 printer?",
      { maxTokens: 80, minScore: 0.4 },
    );

    expect(built.relevant).toBe(true);
    expect(built.context).toContain("[1] Note #14 (narrative)");
    expect(built.context).toContain("192.168.1.10");
    expect(built.context).toContain("printer-floor2");
    expect(built.context).toContain("[2] Document: Network-Map.pdf (identifier)");
    expect(built.context).toContain("10.0.0.1");
    expect(built.context).not.toContain("password");
    expect(built.sources).toEqual(["Note #14", "Document: Network-Map.pdf"]);
    expect(built.sourcesLine).toBe("Sources: Note #14, Document: Network-Map.pdf");
    expect(built.tokens).toBeLessThanOrEqual(80);
    expect(events).toEqual([`${built.chunks}:${built.tokens}`]);

    const prompt = buildRagPrompt(silentLogger, built.included, "What’s the IP of the floor 2 printer?", { maxTokens: 3000, minScore: 0.4 });
    expect(prompt.system).toContain("Answer the user's question using only the context below.");
    expect(prompt.system).toContain("not in the knowledge base");
    expect(prompt.user).toContain("Context:\n<untrusted_record_1>");
    expect(prompt.user).toContain("User question:\n<untrusted_question>");
    expect(prompt.user).toContain("192.168.1.10");
  });

  it("signals when there is no relevant context", () => {
    const built = buildRagContext(silentLogger, [], "Where is the spare keyboard?", { maxTokens: 2000, minScore: 0.4 });
    expect(built.relevant).toBe(false);
    expect(built.context).toBe("");
    expect(built.sourcesLine).toBe("");
    expect(buildRagPrompt(silentLogger, [], "Where is the spare keyboard?").relevant).toBe(false);
  });
});
