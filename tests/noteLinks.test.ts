import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { handleText } from "../src/services/assistant/handleText.js";
import { backfillNoteLinks } from "../src/services/notes/links.js";
import { NOW, owner, testDeps } from "./helpers.js";

describe("note links", () => {
  it("links a note to a task and a document, and a second pass does not add duplicates", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    await handleText(deps, user, "Create a task to check the server backup.");
    await db.insertDocument({
      id: randomUUID(),
      userId: user.id,
      title: "Network-Map.pdf",
      originalFilename: "Network-Map.pdf",
      storagePath: "documents/network-map.pdf",
      mimeType: "application/pdf",
      byteSize: 100,
      sha256: "map-hash",
      category: "Network",
      tags: [],
      createdAt: NOW,
    });

    const saved = await handleText(
      deps,
      user,
      "note this: Task 1 is waiting on Network-Map.pdf. The backup window is 2 AM.",
    );
    expect(saved.text).toContain("Saved note 1");
    expect(saved.text).toContain("Linked to task 1 and document 1.");

    const again = await backfillNoteLinks(deps);
    expect(again).toEqual({ tasks: 0, documents: 0, failed: 0 });

    const manual = await handleText(deps, user, "Link note 1 to task 1 and document 1.");
    expect(manual.text).toContain("Linked note 1 to task 1 and document 1.");
    const second = await backfillNoteLinks(deps);
    expect(second.tasks + second.documents).toBe(0);
  });

  it("links a new note to the task the user was just discussing", async () => {
    const { deps } = testDeps();
    const user = await owner(deps.db);
    await handleText(deps, user, "Create a task to replace the toner.");
    await handleText(deps, user, "Mark task 1 as in progress.");
    const saved = await handleText(deps, user, "note this: The spare toner is in the MDF cabinet.");
    expect(saved.text).toContain("Linked to task 1.");
  });

  it("saves a note from a document and skips a task that does not exist", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    await db.insertDocument({
      id: randomUUID(),
      userId: user.id,
      title: "Rack diagram",
      originalFilename: "rack-diagram.pdf",
      storagePath: "documents/rack.pdf",
      mimeType: "application/pdf",
      byteSize: 40,
      sha256: "rack-hash",
      category: "Network",
      tags: [],
      createdAt: NOW,
    });
    const saved = await handleText(deps, user, "Remember this from document 1: rack A is the core switch.");
    expect(saved.text).toContain("Linked to document 1.");

    const missing = await handleText(deps, user, "Link this note to task 14.");
    expect(missing.text).toContain("don't have task 14");
    expect(await db.listNotes(user.id)).toHaveLength(1);
  });

  it("backfills a note that already mentions a task number", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    await db.insertTask({
      userId: user.id,
      title: "Check backup",
      description: "Check backup",
      category: "General",
      priority: "normal",
      status: "pending",
      dueAt: null,
      tags: [],
      createdAt: NOW,
    });
    await db.insertNote({
      userId: user.id,
      title: "Backup",
      content: "See task 1 before the window.",
      category: "General",
      tags: [],
      createdAt: NOW,
    });
    const first = await backfillNoteLinks(deps);
    expect(first).toEqual({ tasks: 1, documents: 0, failed: 0 });
    const second = await backfillNoteLinks(deps);
    expect(second).toEqual({ tasks: 0, documents: 0, failed: 0 });
  });
});
