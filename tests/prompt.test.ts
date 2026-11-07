import { describe, expect, it } from "vitest";
import { buildRagMessages } from "../src/services/rag/prompt.js";

const context = ["[1] Note #14 (narrative)", "The printer-floor2 uses 192.168.1.10."].join("\n");

describe("rag prompts", () => {
  it("builds a grounded messages list and a fallback when context is missing", () => {
    const rag = buildRagMessages("What’s the IP of the floor 2 printer?", context, {
      sourcesLine: "Sources: Note #14",
    });
    expect(rag.mode).toBe("rag");
    expect(rag.messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(rag.system).toContain("Answer the user's question using only the context below.");
    expect(rag.system).toContain("not in the knowledge base");
    expect(rag.system).toContain("exactly as they appear");
    expect(rag.user).toContain("Context:\n<untrusted_record_1>");
    expect(rag.user).toContain("192.168.1.10");
    expect(rag.user).toContain("User question:\n<untrusted_question>");
    expect(rag.sourcesLine).toBe("Sources: Note #14");
    expect(rag.messages[0]?.content).toBe(rag.system);
    expect(rag.messages[1]?.content).toBe(rag.user);

    const fallback = buildRagMessages("Where is the spare keyboard?", null);
    expect(fallback.mode).toBe("fallback");
    expect(fallback.system).toContain("No relevant notes or documents were retrieved.");
    expect(fallback.user).not.toContain("Context:");
    expect(fallback.user).toContain("<untrusted_question>");
    expect(fallback.sourcesLine).toBe("");

    const brief = buildRagMessages("What’s the IP of the floor 2 printer?", context, { style: "brief" });
    expect(brief.system).toContain("at most two short sentences");
  });
});
