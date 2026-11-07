import { describe, expect, it } from "vitest";
import { GrokError } from "../src/utils/errors.js";
import { ingestKnowledge } from "../src/services/rag/ingest.js";
import { NOW, owner, testDeps } from "./helpers.js";

function vector(): number[] {
  return [1, ...new Array(1023).fill(0)];
}

describe("knowledge ingest", () => {
  it("embeds a note once, skips it on the next run, and updates it after the text changes", async () => {
    const { deps, db } = testDeps();
    const prefixed: string[] = [];
    let calls = 0;
    deps.llm = {
      async completeStructured() {
        throw new Error("unused");
      },
      async completeText() {
        throw new Error("unused");
      },
      async embed(input) {
        calls += 1;
        prefixed.push(...input.texts);
        return { vectors: input.texts.map(() => vector()), inputTokens: 4 };
      },
    };
    const user = await owner(db);
    const note = await db.insertNote({
      userId: user.id,
      title: "Guest VLAN",
      content: "VLAN 20 is the guest network on the floor 2 switches.",
      category: "Networking",
      tags: [],
      createdAt: NOW,
    });
    await db.insertNote({
      userId: user.id,
      title: "Hi",
      content: "Hi",
      category: "General",
      tags: [],
      createdAt: NOW,
    });

    const first = await ingestKnowledge(deps);
    expect(first).toEqual({ processed: 1, skipped: 1, failed: 0, narrative: 1, identifier: 0 });
    expect(prefixed[0]?.startsWith("passage: ")).toBe(true);
    const stored = await db.listChunks(user.id, "note", note.id);
    expect(stored.map((chunk) => chunk.chunkIndex)).toEqual([0]);
    expect(stored[0]?.embeddingModel).toBe("v1");
    expect(stored[0]?.content).toContain("VLAN 20");
    expect(stored[0]?.sourceNumber).toBe(note.noteNumber);

    const second = await ingestKnowledge(deps);
    expect(second).toEqual({ processed: 0, skipped: 2, failed: 0, narrative: 0, identifier: 0 });
    expect(calls).toBe(1);
    expect(await db.listChunks(user.id, "note", note.id)).toHaveLength(1);

    await db.updateNote({
      ...note,
      content: "VLAN 20 is the guest network on the floor 2 switches. The core switch is 10.0.0.2.",
      updatedAt: NOW,
    });
    const third = await ingestKnowledge(deps);
    expect(third.processed).toBe(1);
    expect(calls).toBe(2);
    const updated = await db.listChunks(user.id, "note", note.id);
    expect(updated.some((chunk) => chunk.content.includes("10.0.0.2"))).toBe(true);
  });

  it("retries a rate limit and keeps going when another record fails", async () => {
    const { deps, db } = testDeps();
    let guestCalls = 0;
    deps.llm = {
      async completeStructured() {
        throw new Error("unused");
      },
      async completeText() {
        throw new Error("unused");
      },
      async embed(input) {
        const text = input.texts.join("\n");
        if (text.includes("broken")) throw new GrokError("nope", false, 400);
        guestCalls += 1;
        if (guestCalls < 3) throw new GrokError("rate limit", true, 429);
        return { vectors: input.texts.map(() => vector()), inputTokens: 2 };
      },
    };
    const user = await owner(db);
    await db.insertNote({
      userId: user.id,
      title: "Guest VLAN",
      content: "VLAN 20 is the guest network on the floor 2 switches.",
      category: "Networking",
      tags: [],
      createdAt: NOW,
    });
    await db.insertKnowledge({
      userId: user.id,
      title: "Broken record",
      content: "This broken passage should not stop the run.",
      category: "General",
      tags: [],
      createdAt: NOW,
    });

    const counts = await ingestKnowledge(deps);
    expect(counts.processed).toBe(1);
    expect(counts.failed).toBe(1);
    expect(guestCalls).toBe(3);
  });
});
