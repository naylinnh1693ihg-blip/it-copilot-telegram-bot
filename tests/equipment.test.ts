import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { LlmClient } from "../src/services/grok/client.js";
import { handleText } from "../src/services/assistant/handleText.js";
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

describe("equipment", () => {
  it("creates, shows, and lists a card without Grok", async () => {
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

    const saved = await handleText(deps, user, "Add equipment: HP LaserJet, Floor 2, 192.168.1.10");
    expect(saved.text).toContain("Saved equipment.");
    expect(saved.text).toContain("Equipment: HP LaserJet");
    expect(saved.text).toContain("Type: Printer");
    expect(saved.text).toContain("Location: Floor 2");
    expect(saved.text).toContain("IP: 192.168.1.10");
    expect(events).toContain("equipment");

    const multiline = await handleText(
      deps,
      user,
      "Save switch:\nMain switch\nMDF closet\n10.0.0.2",
    );
    expect(multiline.text).toContain("Type: Switch");
    expect(multiline.text).toContain("IP: 10.0.0.2");

    const one = await handleText(deps, user, "What's the IP of the main switch?");
    expect(one.text).toContain("Equipment: Main switch");
    expect(one.text).toContain("IP: 10.0.0.2");
    expect(one.text).not.toContain("HP LaserJet");

    const named = await handleText(deps, user, "show equipment HP LaserJet");
    expect(named.text).toContain("IP: 192.168.1.10");

    const printers = await handleText(deps, user, "list printers");
    expect(printers.text).toContain("Printers");
    expect(printers.text).toContain("HP LaserJet");
    expect(printers.text).not.toContain("Main switch");

    const switches = await handleText(deps, user, "show switches");
    expect(switches.text).toContain("Main switch");
    expect(switches.text).not.toContain("HP LaserJet");

    const updated = await handleText(deps, user, "Add equipment: HP LaserJet, Floor 3, 192.168.1.11");
    expect(updated.text).toContain("Updated equipment.");
    expect(updated.text).toContain("IP: 192.168.1.11");
    expect(await db.listEquipment(user.id)).toHaveLength(2);
  });

  it("asks for a missing IP locally", async () => {
    const { deps, db } = testDeps();
    deps.llm = throwingLlm();
    const user = await owner(db);
    const reply = await handleText(deps, user, "Add equipment: HP LaserJet, Floor 2");
    expect(reply.text).toContain("I need an IP address");
    expect(await db.listEquipment(user.id)).toHaveLength(0);
  });

  it("keeps notes and task lists on their own path", async () => {
    const { deps, db } = testDeps();
    deps.llm = throwingLlm();
    const user = await owner(db);
    const note = await handleText(deps, user, "Remember this: The meeting room printer uses a static IP.");
    expect(note.text).toContain("Saved memory");
    expect(await db.listEquipment(user.id)).toHaveLength(0);
    const tasks = await handleText(deps, user, "Show my pending tasks.");
    expect(tasks.text.toLowerCase()).toContain("no pending");
  });

  it("extracts equipment from a note or document with Grok and stores the source", async () => {
    const { deps, db } = testDeps();
    const schemas: string[] = [];
    deps.llm = {
      async completeStructured(input) {
        schemas.push(input.schemaName);
        const ip = input.user.includes("Network Map") ? "10.8.0.4" : "192.168.1.50";
        const name = input.user.includes("Network Map") ? "Lobby AP" : "Core switch";
        const type = input.user.includes("Network Map") ? "access_point" : "switch";
        return {
          text: JSON.stringify({
            items: [{ name, type, location: "MDF", ip, notes: "" }],
          }),
          inputTokens: 12,
          outputTokens: 20,
        };
      },
      async completeText() {
        throw new Error("completeText");
      },
    };
    const events: string[] = [];
    deps.logger = {
      info(obj) {
        events.push(`${obj.route}:${obj.intent}`);
      },
      warn() {},
      error() {},
      debug() {},
    };
    const user = await owner(db);
    await handleText(deps, user, "note this: Core switch lives in the MDF at 192.168.1.50.");

    const fromNote = await handleText(deps, user, "Extract equipment from note 1");
    expect(schemas).toEqual(["equipment_cards"]);
    expect(events).toContain("grok:equipment_extract");
    expect(fromNote.text).toContain("Equipment: Core switch");
    expect(fromNote.text).toContain("IP: 192.168.1.50");
    expect(fromNote.text).toContain("Source: Note #1");

    const document = await db.insertDocument({
      id: randomUUID(),
      userId: user.id,
      title: "Network Map.pdf",
      originalFilename: "Network Map.pdf",
      storagePath: "documents/network-map.pdf",
      mimeType: "application/pdf",
      byteSize: 100,
      sha256: "abc123",
      category: "Network",
      tags: [],
      createdAt: NOW,
    });
    await db.saveExtraction({
      documentId: document.id,
      text: "Lobby AP is on the first floor.",
      truncated: false,
      extractedAt: NOW,
    });
    const fromDocument = await handleText(deps, user, "Extract equipment from document 1.");
    expect(fromDocument.text).toContain("Equipment: Lobby AP");
    expect(fromDocument.text).toContain("Type: Access point");
    expect(fromDocument.text).toContain('Source: Document "Network Map.pdf"');
    expect(schemas).toEqual(["equipment_cards", "equipment_cards"]);
  });
});
