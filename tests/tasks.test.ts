import { describe, expect, it } from "vitest";
import { handleText } from "../src/services/assistant/handleText.js";
import { owner, testDeps } from "./helpers.js";

describe("tasks", () => {
  it("accepts today as a due date and sets it to the end of the user's day", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);

    const reply = await handleText(deps, user, "Create a task to review the switch today.");

    expect(reply.text).toContain("Created task 1");
    expect((await db.listTasks(user.id))[0]?.dueAt).toBe("2026-10-30T19:59:59.999Z");
  });

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

  it("creates several tasks from one structured message without calling Grok", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    deps.llm = {
      async completeStructured() {
        throw new Error("should not classify a structured list");
      },
      async completeText() {
        throw new Error("should not generate");
      },
    };

    const bullets = await handleText(
      deps,
      user,
      ["Create tasks:", "- Fix the printer on floor 2", "- Update firewall rules for guest WiFi", "- Call vendor about the switch RMA"].join("\n"),
    );
    expect(bullets.text).toBe(
      ["Created 3 tasks:", "1. Fix the printer on floor 2", "2. Update firewall rules for guest WiFi", "3. Call vendor about the switch RMA"].join("\n"),
    );

    const commas = await handleText(deps, user, "Add these tasks: label the patch panel, replace the AP battery");
    expect(commas.text).toContain("Created 2 tasks:");
    expect(commas.text).toContain("1. label the patch panel");

    const numbered = await handleText(deps, user, ["Make tasks for:", "1. Check the UPS", "2. Email the night shift"].join("\n"));
    expect(numbered.text).toContain("Created 2 tasks:");
    expect(numbered.text).toContain("2. Email the night shift");

    expect(await db.listTasks(user.id)).toHaveLength(7);
  });

  it("asks Grok to split an unstructured multi-task message", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    let schemaName = "";
    deps.llm = {
      async completeStructured(input) {
        schemaName = input.schemaName;
        return {
          text: JSON.stringify({
            tasks: [
              { title: "Fix the printer on floor 2", notes: "" },
              { title: "Call vendor about the switch RMA", notes: "Ask for the RMA number" },
            ],
          }),
          inputTokens: 8,
          outputTokens: 6,
        };
      },
      async completeText() {
        throw new Error("unused");
      },
    };

    const reply = await handleText(deps, user, "Create tasks: the floor 2 printer is jammed and the switch still needs an RMA.");
    expect(schemaName).toBe("multi_task_request");
    expect(reply.text).toContain("Created 2 tasks:");
    expect(reply.text).toContain("1. Fix the printer on floor 2");
    expect(reply.text).toContain("2. Call vendor about the switch RMA");
    const tasks = await db.listTasks(user.id);
    expect(tasks).toHaveLength(2);
    expect(tasks[1]?.description).toContain("RMA number");
  });

  it("keeps a singular create-a-task message as one task", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    const reply = await handleText(deps, user, "Create a task to check switches, then label them.");
    expect(reply.text).toContain("Created task 1");
    expect(reply.text).not.toContain("Created 2 tasks");
    expect(await db.listTasks(user.id)).toHaveLength(1);
  });

  it("lists tasks and saves notes locally, including empty lists and empty notes", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    deps.llm = {
      async completeStructured() {
        throw new Error("should not classify");
      },
      async completeText() {
        throw new Error("should not generate");
      },
      async completeWithTools() {
        throw new Error("should not use tools");
      },
    };

    const phrases = ["show my tasks", "  my   pending tasks  ", "OPEN TASKS", "what's on my list?", "list tasks"];
    for (const phrase of phrases) {
      const reply = await handleText(deps, user, phrase);
      expect(reply.text).toContain("no pending tasks");
    }

    const empty = await handleText(deps, user, "Remember this:");
    expect(empty.text).toContain("What should I remember?");
    expect(await db.listNotes(user.id)).toHaveLength(0);

    const saved = await handleText(deps, user, "remember: The meeting room printer uses a static IP.");
    expect(saved.text).toContain("Saved note 1");
    const noted = await handleText(deps, user, "note this: Check the UPS nightly.");
    expect(noted.text).toContain("Saved note 2");
    const savedThis = await handleText(deps, user, "save this: VLAN 20 is the guest network.");
    expect(savedThis.text).toContain("Saved note 3");
    expect(await db.listNotes(user.id)).toHaveLength(3);
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
