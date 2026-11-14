import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { handleText } from "../src/services/assistant/handleText.js";
import { indexSavedText } from "../src/services/rag/index.js";
import { NOW, owner, testDeps } from "./helpers.js";

async function saveDocument(setup: ReturnType<typeof testDeps>, userId: string, title: string) {
  const id = randomUUID();
  const path = `${userId}/${id}/${id}.pdf`;
  await setup.storage.upload(path, Buffer.from("pdf body"), "application/pdf");
  const document = await setup.db.insertDocument({
    id,
    userId,
    title,
    originalFilename: "switch.pdf",
    storagePath: path,
    mimeType: "application/pdf",
    byteSize: 8,
    sha256: `hash-${id}`,
    category: "General",
    tags: [],
    createdAt: NOW,
  });
  await indexSavedText(setup.deps, { userId, source: "document", sourceId: id, sourceNumber: document.documentNumber, title, text: `${title}\nVLAN 20 is the guest network.` });
  return document;
}

describe("delete document", () => {
  it("asks first, then deletes the record, file, and search index on YES", async () => {
    const setup = testDeps();
    const user = await owner(setup.db);
    const document = await saveDocument(setup, user.id, "Cisco switch config");
    expect((await setup.db.listChunks(user.id, "document", document.id)).length).toBeGreaterThan(0);

    const ask = await handleText(setup.deps, user, "Delete document 1");
    expect(ask.text).toContain("Delete document 1: Cisco switch config");
    expect(ask.keyboard).toBe("confirm");
    expect(await setup.db.findDocument(user.id, 1)).not.toBeNull();
    expect(setup.storage.has(document.storagePath)).toBe(true);

    const done = await handleText(setup.deps, user, "YES");
    expect(done.text).toBe("Deleted document 1: Cisco switch config.");
    expect(await setup.db.findDocument(user.id, 1)).toBeNull();
    expect(await setup.db.listDocuments(user.id)).toHaveLength(0);
    expect(setup.storage.has(document.storagePath)).toBe(false);
    expect(await setup.db.listChunks(user.id, "document", document.id)).toHaveLength(0);

    const again = await handleText(setup.deps, user, "Delete document 1");
    expect(again.text).toBe("I don't have document 1.");
  });

  it("keeps the document when the user says NO or moves on", async () => {
    const setup = testDeps();
    const user = await owner(setup.db);
    const document = await saveDocument(setup, user.id, "Floor plan");

    await handleText(setup.deps, user, "remove document #1.");
    expect((await handleText(setup.deps, user, "NO")).text).toBe("Okay. I left it unchanged.");
    await handleText(setup.deps, user, "Delete document 1");
    await handleText(setup.deps, user, "help");
    expect((await handleText(setup.deps, user, "YES")).text).toBe("There is nothing waiting for confirmation.");

    expect(await setup.db.findDocument(user.id, 1)).not.toBeNull();
    expect(setup.storage.has(document.storagePath)).toBe(true);
  });

  it("does not delete when the confirmation has expired", async () => {
    const setup = testDeps();
    const user = await owner(setup.db);
    await saveDocument(setup, user.id, "Floor plan");
    await handleText(setup.deps, user, "Delete document 1");
    const later = setup.deps.clock.now().plus({ minutes: 11 });
    setup.deps.clock = { now: () => later };
    expect((await handleText(setup.deps, user, "YES")).text).toContain("expired");
    expect(await setup.db.findDocument(user.id, 1)).not.toBeNull();
  });

  it("says so when the file could not be removed, and still hides the document", async () => {
    const setup = testDeps();
    const user = await owner(setup.db);
    await saveDocument(setup, user.id, "Floor plan");
    setup.deps.storage.remove = async () => {
      throw new Error("bucket unavailable");
    };
    await handleText(setup.deps, user, "Delete document 1");
    const done = await handleText(setup.deps, user, "YES");
    expect(done.text).toContain("couldn't remove the stored file");
    expect(await setup.db.findDocument(user.id, 1)).toBeNull();
  });

  it("does not ask about a document that does not exist", async () => {
    const setup = testDeps();
    const user = await owner(setup.db);
    const reply = await handleText(setup.deps, user, "Delete document 9");
    expect(reply.text).toBe("I don't have document 9.");
    expect(reply.keyboard).toBeUndefined();
  });
});

describe("delete equipment", () => {
  it("asks first, then deletes the card by name on YES", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    const saved = await handleText(deps, user, "Add equipment: HP LaserJet, Floor 2, 192.168.1.10");
    expect(saved.text).toContain("Number: 1");

    const ask = await handleText(deps, user, "Delete equipment HP LaserJet");
    expect(ask.text).toContain("Delete equipment 1: HP LaserJet (192.168.1.10, Floor 2)?");
    expect(ask.keyboard).toBe("confirm");
    expect(await db.listEquipment(user.id)).toHaveLength(1);

    expect((await handleText(deps, user, "YES")).text).toBe("Deleted equipment 1: HP LaserJet.");
    expect(await db.listEquipment(user.id)).toHaveLength(0);
    expect((await handleText(deps, user, "List equipment")).text).toBe("You have no equipment yet.");
  });

  it("deletes by number or IP and leaves other cards alone", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    await handleText(deps, user, "Add equipment: HP LaserJet, Floor 2, 192.168.1.10");
    await handleText(deps, user, "Add equipment: Main switch, Server room, 192.168.1.2");

    await handleText(deps, user, "Delete equipment 2");
    await handleText(deps, user, "yes");
    await handleText(deps, user, "remove equipment 192.168.1.10");
    expect((await handleText(deps, user, "NO")).text).toBe("Okay. I left it unchanged.");
    expect((await db.listEquipment(user.id)).map((item) => item.name)).toEqual(["HP LaserJet"]);
  });

  it("lists the matches instead of guessing when a name is ambiguous", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    await handleText(deps, user, "Add equipment: HP LaserJet Floor 2, Floor 2, 192.168.1.10");
    await handleText(deps, user, "Add equipment: HP LaserJet Floor 3, Floor 3, 192.168.1.11");

    const reply = await handleText(deps, user, "Delete equipment HP LaserJet");
    expect(reply.text).toContain("More than one card matches");
    expect(reply.keyboard).toBeUndefined();
    expect((await handleText(deps, user, "YES")).text).toBe("There is nothing waiting for confirmation.");
    expect(await db.listEquipment(user.id)).toHaveLength(2);
  });

  it("says so when no card matches", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    expect((await handleText(deps, user, "Delete equipment core router")).text).toBe('I don\'t have equipment matching "core router".');
  });
});
