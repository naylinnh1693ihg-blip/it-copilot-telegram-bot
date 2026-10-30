import { describe, expect, it } from "vitest";
import { handleText } from "../src/services/assistant/handleText.js";
import { owner, testDeps } from "./helpers.js";

describe("tasks", () => {
  it("creates, lists, completes, moves, and deletes with confirmation", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);

    const created = await handleText(deps, user, "Create a task to check the Cisco switches tomorrow.");
    expect(created.text).toContain("Created task 1");
    expect(created.text).toContain("31 Oct 2026, 9:00 AM");

    const urgent = await handleText(deps, user, "Add a high-priority task to investigate the Wi-Fi problem by 3 PM.");
    expect(urgent.text).toContain("Priority high");
    expect(urgent.text).toContain("3:00 PM");

    const pending = await handleText(deps, user, "Show my pending tasks.");
    expect(pending.text).toContain("Cisco switches");
    expect(pending.text).toContain("Wi-Fi");

    const today = await handleText(deps, user, "Show today's tasks.");
    expect(today.text).toContain("Wi-Fi");
    expect(today.text).not.toContain("Cisco switches");

    await handleText(deps, user, "Mark task 1 as completed.");
    const overdue = await handleText(deps, user, "Which tasks are overdue?");
    expect(overdue.text).toContain("no overdue tasks");

    const moved = await handleText(deps, user, "Move task 2 to tomorrow.");
    expect(moved.text).toContain("31 Oct 2026");

    const ask = await handleText(deps, user, "Delete task 2.");
    expect(ask.text).toContain("Reply YES");
    expect((await db.listTasks(user.id)).some((task) => task.taskNumber === 2)).toBe(true);
    const deleted = await handleText(deps, user, "YES");
    expect(deleted.text).toContain("Deleted task 2");
    expect(await db.listTasks(user.id)).toHaveLength(1);

    const history = await handleText(deps, user, "history task 2");
    expect(history.text).toContain("deleted");
  });

  it("does not save a casual sentence as a task or note", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    const reply = await handleText(deps, user, "The meeting room printer uses a static IP.");
    expect(reply.text.toLowerCase()).toContain("help");
    expect(await db.listTasks(user.id)).toHaveLength(0);
    expect(await db.listNotes(user.id)).toHaveLength(0);
  });
});
