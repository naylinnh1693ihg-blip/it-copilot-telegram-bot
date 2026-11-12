import { describe, expect, it } from "vitest";
import { handleText } from "../src/services/assistant/handleText.js";
import { memoryVisibleFilter } from "../src/database/supabase.js";
import { MemoryService } from "../src/services/memory/service.js";
import { answerWithRag } from "../src/services/rag/retrieve.js";
import type { LlmClient } from "../src/services/grok/client.js";
import { owner, testDeps } from "./helpers.js";

describe("memories", () => {
  it("stores, lists, and forgets a memory without creating a note", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    const saved = await handleText(deps, user, "Remember that I prefer brief answers");
    expect(saved.text).toContain("Saved memory 1 (preference)");
    expect(await db.listNotes(user.id)).toHaveLength(0);

    const listed = await handleText(deps, user, "/memories");
    expect(listed.text).toContain("prefer brief answers");

    const ask = await handleText(deps, user, "/forget 1");
    expect(ask.text).toContain("YES");
    const forgot = await handleText(deps, user, "YES");
    expect(forgot.text).toContain("Forgot memory 1");
    const empty = await handleText(deps, user, "list memories");
    expect(empty.text).toContain("no saved memories");
  });

  it("does not return another user's memory or an expired one", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    const other = await db.upsertFromTelegram({
      telegramUserId: user.telegramUserId + 1,
      displayName: "Other",
      timezone: user.timezone,
      startedBot: true,
      at: "2026-10-30T10:00:00.000Z",
    });
    const service = new MemoryService(deps);
    await service.storeMemory(other.id, "Other person prefers long answers");
    await service.storeMemory(user.id, "My main site is Floor 2", { expiresAt: "2026-10-01T00:00:00.000Z" });
    const memories = await service.retrieveMemories(user.id);
    expect(memories).toHaveLength(0);
    expect(await service.cleanup(user.id)).toBe(0);
  });

  it("injects a matching memory into a RAG answer", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    deps.llm = {
      async completeStructured() {
        throw new Error("classification should not run");
      },
      async completeText(input) {
        expect(input.user).toContain("Floor 2");
        expect(input.system).toContain("untrusted");
        return { text: "Your main site is Floor 2.", inputTokens: 8, outputTokens: 6 };
      },
    } satisfies LlmClient;
    await handleText(deps, user, "Remember this: my main site is Floor 2");
    const reply = await answerWithRag(deps, user, "What is my main site?");
    expect(reply?.text).toContain("Floor 2");
    expect(reply?.text).toContain("From memory #1");
  });

  it("records the source, confidence, and pin state of a memory", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    const service = new MemoryService(deps);
    const fromChat = await service.storeMemory(user.id, "I prefer brief answers");
    if ("error" in fromChat) throw new Error(fromChat.error);
    expect(fromChat.memory).toMatchObject({ sourceType: "chat", sourceId: null, confidence: 1, pinned: false });

    const goal = await service.storeMemory(user.id, "Finish the switch migration by December", {
      memoryType: "goal",
      sourceType: "admin",
      pinned: true,
    });
    if ("error" in goal) throw new Error(goal.error);
    const stored = await db.findMemory(user.id, goal.memory.memoryNumber);
    expect(stored).toMatchObject({ memoryType: "goal", sourceType: "admin", pinned: true });
  });

  it("keeps a pinned memory in an unrelated answer and does not expire it automatically", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    const service = new MemoryService(deps);
    const pinned = await service.storeMemory(user.id, "I prefer brief answers", { pinned: true, expiresAt: "2026-10-01T00:00:00.000Z" });
    if ("error" in pinned) throw new Error(pinned.error);
    await service.storeMemory(user.id, "The guest VLAN is 20", { expiresAt: "2026-10-01T00:00:00.000Z" });
    expect(await service.cleanup(user.id)).toBe(1);
    const block = await service.promptBlock(user.id, "Where is the printer?");
    expect(block.text).toContain("prefer brief answers");
    expect(block.text).not.toContain("guest VLAN");
  });

  it("quotes memory expiry timestamps so the millisecond dot stays in the filter", () => {
    const filter = memoryVisibleFilter("2026-10-30T06:00:00.000Z");
    expect(filter).toBe('pinned.eq.true,expires_at.is.null,expires_at.gt."2026-10-30T06:00:00.000Z"');
  });
});
