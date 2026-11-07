import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import type { LlmClient } from "../src/services/grok/client.js";
import { handleText } from "../src/services/assistant/handleText.js";
import { parseLocalIntent } from "../src/services/assistant/localIntent.js";
import { toIso } from "../src/utils/time.js";
import { NOW, owner, testDeps } from "./helpers.js";

function throwingLlm(): LlmClient {
  return {
    async completeStructured() {
      throw new Error("Grok should not run");
    },
    async completeText() {
      throw new Error("Grok should not run");
    },
    async completeWithTools() {
      throw new Error("Grok should not run");
    },
  };
}

describe("closed today", () => {
  it("recognizes the local phrases", () => {
    for (const phrase of [
      "What I closed today",
      "What did I close today",
      "Tasks I closed today",
      "Closed today",
      "What did I finish today?",
    ]) {
      expect(parseLocalIntent(phrase)).toMatchObject({ intent: "list_tasks", tags: "closed_today" });
    }
    expect(parseLocalIntent("Show today's tasks.")).toMatchObject({ intent: "list_tasks", list_filter: "today", tags: "" });
  });

  it("lists tasks completed today, oldest first, without Grok", async () => {
    const { deps, db } = testDeps();
    deps.llm = throwingLlm();
    const events: string[] = [];
    deps.logger = {
      info(obj) {
        events.push(String(obj.intent));
      },
      warn() {},
      error() {},
      debug() {},
    };
    const user = await owner(db);
    await handleText(deps, user, "Create a task to fix the printer on floor 2.");
    await handleText(deps, user, "Create a task to update firewall rules.");
    await handleText(deps, user, "Create a task to call vendor about the switch.");
    await handleText(deps, user, "Complete task 2");
    await handleText(deps, user, "Complete task 1");
    await handleText(deps, user, "Complete task 3");

    const reply = await handleText(deps, user, "What did I close today?");
    expect(reply.text).toBe(
      [
        "Closed today (3):",
        "1. update firewall rules (task 2)",
        "2. fix the printer on floor 2 (task 1)",
        "3. call vendor about the switch (task 3)",
      ].join("\n"),
    );
    expect(events).toContain("closed_today");
  });

  it("says when nothing was closed, and ignores yesterday and the next midnight", async () => {
    const { deps, db } = testDeps();
    deps.llm = throwingLlm();
    const user = await owner(db);

    const empty = await handleText(deps, user, "What I closed today");
    expect(empty.text).toBe("You haven't closed any tasks today.");

    const yesterday = await db.insertTask({
      userId: user.id,
      title: "Yesterday's close",
      description: "",
      category: "General",
      priority: "normal",
      status: "completed",
      dueAt: null,
      tags: [],
      createdAt: NOW,
    });
    const early = await db.insertTask({
      userId: user.id,
      title: "Just after midnight",
      description: "",
      category: "General",
      priority: "normal",
      status: "completed",
      dueAt: null,
      tags: [],
      createdAt: NOW,
    });
    const next = await db.insertTask({
      userId: user.id,
      title: "Next midnight",
      description: "",
      category: "General",
      priority: "normal",
      status: "completed",
      dueAt: null,
      tags: [],
      createdAt: NOW,
    });
    await db.addTaskEvent({
      taskId: yesterday.id,
      userId: user.id,
      action: "completed",
      summary: yesterday.title,
      createdAt: toIso(DateTime.fromISO("2026-10-29T23:59:59.000+04:00")),
    });
    await db.addTaskEvent({
      taskId: early.id,
      userId: user.id,
      action: "created",
      summary: early.title,
      createdAt: toIso(DateTime.fromISO("2026-10-30T00:00:01.000+04:00")),
    });
    await db.addTaskEvent({
      taskId: early.id,
      userId: user.id,
      action: "completed",
      summary: early.title,
      createdAt: toIso(DateTime.fromISO("2026-10-30T00:00:01.000+04:00")),
    });
    await db.addTaskEvent({
      taskId: next.id,
      userId: user.id,
      action: "completed",
      summary: next.title,
      createdAt: toIso(DateTime.fromISO("2026-10-31T00:00:00.000+04:00")),
    });

    const reply = await handleText(deps, user, "Closed today");
    expect(reply.text).toBe("Closed today (1):\n1. Just after midnight (task 2)");
  });
});
