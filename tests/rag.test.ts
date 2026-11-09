import { describe, expect, it } from "vitest";
import { blankIntent } from "../src/types/intent.js";
import type { LlmClient } from "../src/services/grok/client.js";
import { handleText } from "../src/services/assistant/handleText.js";
import { chunkText } from "../src/services/rag/chunk.js";
import { answerWithRag } from "../src/services/rag/retrieve.js";
import { formatKnowledgeContext, hybridSearch, prepareKnowledgeMatches } from "../src/services/rag/search.js";
import type { ChunkHit } from "../src/database/types.js";
import { lexicalQuery, lexicalSimilarity } from "../src/database/similarity.js";
import { owner, testDeps } from "./helpers.js";

function vector(): number[] {
  return [1, ...new Array(1023).fill(0)];
}

describe("rag", () => {
  it("uses the identifying terms of a natural-language question for lexical matching", () => {
    const question = "What's the IP of the floor 2 printer?";
    const note = "The floor 2 printer uses IP address 192.168.1.10.";

    expect(lexicalQuery(question)).toBe("ip floor 2 printer");
    expect(lexicalSimilarity(question, note)).toBe(1);
    expect(lexicalSimilarity(question, "The printer on floor 2 has address 192.168.1.10.")).toBeGreaterThan(0.4);
    expect(lexicalSimilarity(question, "Routine network segment VLAN 2.")).toBeLessThan(0.4);
  });

  it("chunks long text inside the token window", () => {
    const chunks = chunkText(`${"switch ".repeat(1500)}`, { chunkTokens: 500, overlapTokens: 80 });
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.chunkType).toBe("narrative");
      expect(chunk.content.length).toBeGreaterThan(0);
      expect(chunk.content.length).toBeLessThanOrEqual((500 + 80) * 4);
    }
  });

  it("keeps a short note as one chunk and adds an identifier chunk for a longer note", () => {
    const short = chunkText("VLAN 20 is the guest network.", { chunkTokens: 500, overlapTokens: 80 });
    expect(short).toEqual([{ content: "VLAN 20 is the guest network.", chunkType: "narrative" }]);

    const filler = "The access layer was rebuilt last spring and the closet on floor 2 now feeds the meeting rooms, the reception desk, and the guest chairs along the east wall. ";
    const note = `${filler.repeat(4)}The meeting room printer uses 192.168.1.10 and the hostname printer-floor2. The model is HP LaserJet M404.`;
    const chunks = chunkText(note, { chunkTokens: 500, overlapTokens: 80, identifierNames: ["Meeting Room Printer"] });
    const narrative = chunks.filter((chunk) => chunk.chunkType === "narrative");
    const identifier = chunks.filter((chunk) => chunk.chunkType === "identifier");
    expect(narrative).toHaveLength(1);
    expect(narrative[0]?.content.length).toBeGreaterThan(600);
    expect(identifier.length).toBeGreaterThan(0);
    expect(identifier.every((chunk) => chunk.content.length <= 150 * 4)).toBe(true);
    expect(identifier.some((chunk) => chunk.content.includes("192.168.1.10") && chunk.content.includes("printer-floor2"))).toBe(true);
    expect(identifier.some((chunk) => chunk.content.includes("HP LaserJet"))).toBe(true);
  });

  it("chunks a printer inventory into labeled rows instead of the header dump", () => {
    const header =
      "printer;location;IPAddress;scannerIP;terminalID;slaveTerminalID;enforcedModel;assetNumber;contact;purchaseDate;Model ;Serial number;MAC;B&W print;Color print";
    const rows = Array.from({ length: 20 }, (_, index) =>
      `Printer ${index};Floor ${index};10.0.${index}.5;10.0.${index}.6;T${index};S${index};HP;A-${index};Sam;2020-01-01;M404;SN${index};AA:BB;1;2`,
    );
    const chunks = chunkText([`printer informations: ${header}`, ...rows].join("\n"), { chunkTokens: 500, overlapTokens: 80 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.chunkType === "narrative")).toBe(true);
    expect(chunks.some((chunk) => chunk.content.includes("IPAddress: 10.0.1.5"))).toBe(true);
    expect(chunks.every((chunk) => !chunk.content.includes("scannerIP;terminalID"))).toBe(true);
    expect(chunks.every((chunk) => chunk.content.length <= 500 * 4)).toBe(true);
  });

  it("can chunk long documents without redundant identifier windows", () => {
    const text = `${"The site has several network closets and access switches. ".repeat(10_000)}Core switch IP: 10.1.2.3.`;
    const chunks = chunkText(text, {
      chunkTokens: 800,
      overlapTokens: 0,
      includeIdentifierChunks: false,
    });

    expect(chunks.length).toBeLessThan(200);
    expect(chunks.every((chunk) => chunk.chunkType === "narrative")).toBe(true);
    expect(chunks.some((chunk) => chunk.content.includes("10.1.2.3"))).toBe(true);
  });

  it("answers a question from a saved note without classifying the intent", async () => {
    const { deps, db } = testDeps();
    const calls: string[] = [];
    deps.llm = {
      async completeStructured() {
        calls.push("structured");
        throw new Error("classification should not run");
      },
      async completeText(input) {
        calls.push("text");
        expect(input.user).toContain("VLAN 20 is the guest network");
        expect(input.user).toContain("untrusted_question");
        return { text: "VLAN 20 is the guest network.", inputTokens: 20, outputTokens: 10 };
      },
    } satisfies LlmClient;
    const events: string[] = [];
    deps.logger = {
      info(obj) {
        if (obj.event === "rag_retrieval") events.push(`${obj.chunks}`);
      },
      warn() {},
      error() {},
      debug() {},
    };
    const user = await owner(db);
    await handleText(deps, user, "Remember this: VLAN 20 is the guest network.");
    const reply = await handleText(deps, user, "What is VLAN 20?");
    expect(calls).toEqual(["text"]);
    expect(events).toEqual(["1"]);
    expect(reply.text).toContain("VLAN 20 is the guest network.");
    expect(reply.text).toContain("From note #1");
  });

  it("answers an identifying question from saved text when embeddings are unavailable", async () => {
    const { deps, db } = testDeps();
    deps.llm = {
      async completeStructured() {
        throw new Error("classification should not run");
      },
      async completeText(input) {
        expect(input.user).toContain("192.168.1.10");
        return { text: "The floor 2 printer IP is 192.168.1.10.", inputTokens: 10, outputTokens: 8 };
      },
    } satisfies LlmClient;
    const user = await owner(db);
    await handleText(deps, user, "Remember this: The floor 2 printer uses IP address 192.168.1.10.");

    const reply = await answerWithRag(deps, user, "What's the IP of the floor 2 printer?");

    expect(reply).not.toBeNull();
    expect(reply?.text).toContain("192.168.1.10");
    expect(reply?.text).toContain("From note #1");
  });

  it("does not treat a grounded answer containing an uncertainty phrase as a refusal", async () => {
    const { deps, db } = testDeps();
    deps.llm = {
      async completeStructured() {
        throw new Error("classification should not run");
      },
      async completeText() {
        return {
          text: "I don't know how to configure that switch, but its management VLAN is 21.",
          inputTokens: 10,
          outputTokens: 8,
        };
      },
    };
    const user = await owner(db);
    await handleText(deps, user, "Remember this: The switch management VLAN is 21.");

    const reply = await answerWithRag(deps, user, "What is the switch management VLAN?");

    expect(reply?.text).toContain("I don't know how to configure that switch");
    expect(reply?.text).toContain("management VLAN is 21");
    expect(reply?.text).toContain("From note #1");
  });

  it("does not stream unvalidated RAG text to previews", async () => {
    const { deps, db } = testDeps();
    deps.llm = {
      async completeStructured() {
        throw new Error("classification should not run");
      },
      async completeText() {
        throw new Error("streaming should be used");
      },
      async streamText(input) {
        await input.onDelta?.("The printer IP is 203.0.113.99.");
        return { text: "The printer IP is 203.0.113.99.", inputTokens: 10, outputTokens: 8 };
      },
    };
    const user = await owner(db);
    await handleText(deps, user, "Remember this: The floor 2 printer is near reception.");
    const previews: string[] = [];

    const reply = await answerWithRag(deps, user, "Where is the floor 2 printer?", async (text) => {
      previews.push(text);
    });

    expect(previews).toEqual(["Searching…"]);
    expect(reply?.text).toBe("I don't know that from your notes and documents.");
  });

  it("uses a shared embedding when the wording does not match", async () => {
    const { deps, db } = testDeps();
    deps.llm = {
      async completeStructured() {
        throw new Error("classification should not run");
      },
      async completeText() {
        return { text: "Guests use VLAN 20.", inputTokens: 8, outputTokens: 4 };
      },
      async embed() {
        return { vectors: [vector()], inputTokens: 4 };
      },
    };
    const user = await owner(db);
    await handleText(deps, user, "Remember this: the visitor segment is vlan twenty.");
    const reply = await handleText(deps, user, "Where should guests connect?");
    expect(reply.text).toContain("Guests use VLAN 20.");
    expect(reply.text).toContain("From note #1");
  });

  it("ignores a vector from a different embedding model", async () => {
    const { deps, db } = testDeps();
    const calls: string[] = [];
    deps.llm = {
      async completeStructured() {
        calls.push("structured");
        return {
          text: JSON.stringify(blankIntent({ intent: "clarify", clarification_question: "I don't have that saved." })),
          inputTokens: 1,
          outputTokens: 1,
        };
      },
      async completeText() {
        calls.push("text");
        return { text: "This should not be used.", inputTokens: 1, outputTokens: 1 };
      },
      async embed() {
        return { vectors: [vector()], inputTokens: 2 };
      },
    };
    const user = await owner(db);
    await db.replaceChunks(user.id, "note", user.id, [
      {
        source: "note",
        sourceId: user.id,
        sourceNumber: 9,
        title: "Old model",
        chunkIndex: 0,
        chunkType: "narrative",
        content: "unrelated stored passage",
        embedding: vector(),
        embeddingModel: "retired-model",
        metadata: { chunk_type: "narrative", embedding_model: "retired-model" },
      },
    ]);
    const reply = await handleText(deps, user, "Where should guests connect?");
    expect(calls).toEqual(["structured"]);
    expect(reply.text).toContain("I don't have that saved.");
  });

  it("reindexes a note after it is updated", async () => {
    const { deps, db } = testDeps();
    deps.llm = {
      async completeStructured() {
        throw new Error("classification should not run");
      },
      async completeText(input) {
        expect(input.user).toContain("floor 2");
        return { text: "VLAN 20 is also on floor 2.", inputTokens: 5, outputTokens: 5 };
      },
    };
    const user = await owner(db);
    await handleText(deps, user, "Remember this: VLAN 20 is the guest network.");
    await handleText(deps, user, "Update my VLAN notes: it is also on floor 2.");
    const reply = await handleText(deps, user, "What is VLAN 20?");
    expect(reply.text).toContain("floor 2");
    expect(reply.text).toContain("From note #1");
  });

  it("leaves local commands and unknown questions on their existing paths", async () => {
    const { deps, db } = testDeps();
    const calls: string[] = [];
    deps.llm = {
      async completeStructured() {
        calls.push("structured");
        return {
          text: JSON.stringify(blankIntent({ intent: "clarify", clarification_question: "I don't have that saved." })),
          inputTokens: 1,
          outputTokens: 1,
        };
      },
      async completeText() {
        calls.push("text");
        throw new Error("RAG should not answer");
      },
    };
    const user = await owner(db);
    const tasks = await handleText(deps, user, "Show my pending tasks.");
    expect(tasks.text).toContain("no pending tasks");
    expect(calls).toEqual([]);

    const missing = await handleText(deps, user, "Where is the spare keyboard?");
    expect(missing.text).toContain("I don't have that saved.");
    expect(calls).toEqual(["structured"]);
  });

  it("searches with a query embedding and formats narrative and identifier context", async () => {
    const { deps, db } = testDeps();
    const prefixed: string[] = [];
    deps.llm = {
      async completeStructured() {
        throw new Error("unused");
      },
      async completeText() {
        throw new Error("unused");
      },
      async embed(input) {
        prefixed.push(input.texts[0] ?? "");
        throw new Error("rate limit");
      },
    };
    const user = await owner(db);
    const sourceId = user.id;
    await db.replaceChunks(user.id, "note", sourceId, [
      {
        source: "note",
        sourceId,
        sourceNumber: 14,
        title: "Floor 2 printer",
        chunkIndex: 0,
        chunkType: "narrative",
        content: "The main printer on floor 2 is an HP LaserJet at 192.168.1.10.",
        embedding: null,
        embeddingModel: null,
        metadata: { chunk_type: "narrative", embedding_model: null },
      },
    ]);
    await db.replaceChunks(user.id, "document", sourceId, [
      {
        source: "document",
        sourceId,
        sourceNumber: 2,
        title: "Network-Map.pdf",
        chunkIndex: 1,
        chunkType: "identifier",
        content: "Switch-Core IP: 10.0.0.1",
        embedding: null,
        embeddingModel: "v1",
        metadata: { chunk_type: "identifier", embedding_model: "v1" },
      },
    ]);

    const results = await hybridSearch(deps, user.id, "What is the floor 2 printer IP?");
    expect(prefixed[0]).toBe("query: What is the floor 2 printer IP?");
    expect(results[0]).toMatchObject({
      sourceType: "note",
      sourceId,
      title: "Floor 2 printer",
      metadata: { chunk_type: "narrative" },
    });
    expect(results[0]?.content).toContain("192.168.1.10");
    expect(results[0]?.score).toBeGreaterThan(0.4);
    expect(formatKnowledgeContext(results)).toContain("[1] Note #14 (narrative)\nThe main printer on floor 2 is an HP LaserJet at 192.168.1.10.");

    const ranked = prepareKnowledgeMatches(
      [
        sampleHit({ content: "A".repeat(200), score: 0.95, chunkType: "narrative" }),
        sampleHit({ content: "B".repeat(200), score: 0.9, chunkType: "narrative", sourceId: "other" }),
        sampleHit({ content: "Switch-Core IP: 10.0.0.1", score: 0.86, chunkType: "identifier", sourceId: "map", source: "document", title: "Network-Map.pdf" }),
        sampleHit({ content: "A".repeat(180), score: 0.94, chunkType: "identifier" }),
        sampleHit({ content: "unrelated", score: 0.1, chunkType: "narrative", sourceId: "low" }),
      ],
      2,
      0.4,
    );
    expect(ranked.map((hit) => hit.metadata.chunk_type)).toEqual(["narrative", "identifier"]);
    expect(await hybridSearch(deps, user.id, "   ")).toEqual([]);
  });
});

function sampleHit(input: { content: string; score: number; chunkType: "narrative" | "identifier"; sourceId?: string; source?: "note" | "document"; title?: string }): ChunkHit {
  const chunkType = input.chunkType;
  return {
    source: input.source ?? "note",
    sourceId: input.sourceId ?? "same-note",
    sourceNumber: 14,
    title: input.title ?? "Floor 2 printer",
    content: input.content,
    chunkType,
    lexical: input.score,
    vectorScore: 0,
    score: input.score,
    metadata: { chunk_type: chunkType, embedding_model: "v1" },
  };
}
