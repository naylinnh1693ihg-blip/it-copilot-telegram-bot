import type { Context } from "grammy";
import { describe, expect, it } from "vitest";
import { createLiveAnalysis, sendReply } from "../src/bot/handlers/messages.js";
import { copyButtonsFor, groundedCopyButtons } from "../src/services/assistant/copyButtons.js";
import { execute } from "../src/services/assistant/execute.js";
import { handleText } from "../src/services/assistant/handleText.js";
import { answerWithRag } from "../src/services/rag/retrieve.js";
import type { LlmClient } from "../src/services/grok/client.js";
import { blankIntent } from "../src/types/intent.js";
import { owner, testDeps } from "./helpers.js";

const CREATED = "2026-10-30T10:00:00.000+04:00";
const PRINTER_HEADER =
  "printer;location;IPAddress;scannerIP;terminalID;slaveTerminalID;enforcedModel;assetNumber;contact;purchaseDate;Model ;Serial number;MAC;B&W print;Color print;B&W copies;Color copies";

function grokAnswering(text: string): LlmClient {
  return {
    async completeStructured() {
      throw new Error("classification should not run");
    },
    async completeText() {
      return { text, inputTokens: 1, outputTokens: 1 };
    },
  };
}

describe("copy buttons from saved records", () => {
  it("offers the IP, serial, and MAC of the printer found by IP", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    await db.insertNote({
      userId: user.id,
      title: "metered printers",
      content: [
        PRINTER_HEADER,
        "BOH;Back Office House;10.100.12.223;;789;;;;;;SHARP MX-3051;1510943600;AC-A8-8E-F7-AA-97;206248;46347;8074",
        "Kitchen;Kitchen -B4;10.100.12.237;;;;;;;;P-4026iw MFP;VNU4139887;D4-F0-C9-0D-E0-FB",
      ].join("\n"),
      category: "",
      tags: [],
      createdAt: CREATED,
    });
    const reply = await execute(deps, user, blankIntent({ intent: "search_notes", search_query: "10.100.12.223" }), { confirmed: false });
    expect(reply.copyButtons).toEqual([
      { label: "Copy IP 10.100.12.223", text: "10.100.12.223" },
      { label: "Copy serial 1510943600", text: "1510943600" },
      { label: "Copy MAC AC-A8-8E-F7-AA-97", text: "AC-A8-8E-F7-AA-97" },
    ]);
    expect(reply.copyButtons?.map((button) => button.text)).not.toContain("10.100.12.237");
  });

  it("offers the extension for a directory row", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    await db.insertNote({ userId: user.id, title: "PC directory", content: "HADX-PC01 6722 Alex HADX-PC02 6723 Sam", category: "", tags: [], createdAt: CREATED });
    const reply = await handleText(deps, user, "extension for Alex");
    expect(reply.text).toContain("Extension: 6722");
    expect(reply.copyButtons?.[0]).toEqual({ label: "Copy ext 6722", text: "6722" });
    expect(reply.copyButtons?.map((button) => button.text)).toEqual(["6722", "HADX-PC01"]);
  });

  it("never offers a credential", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    await db.insertNote({
      userId: user.id,
      title: "lab router",
      content: "Router: lab-gw\nIP: 10.9.9.1\nPassword: hunter2\nAdmin PIN: 4412\nAPI token = 10.9.9.77",
      category: "",
      tags: [],
      createdAt: CREATED,
    });
    const reply = await execute(deps, user, blankIntent({ intent: "search_notes", search_query: "lab router" }), { confirmed: false });
    const texts = (reply.copyButtons ?? []).map((button) => button.text);
    expect(texts).not.toContain("hunter2");
    expect(texts).not.toContain("4412");
    expect(texts).not.toContain("10.9.9.77");
    expect(copyButtonsFor("Password: hunter2\npwd: 10.0.0.5\nwifi key: AA-BB-CC-DD-EE-FF")).toEqual([]);
    // RAG context flattens a card onto one line; the secret field must still be split off and skipped.
    expect(copyButtonsFor("[1] Note #2 (narrative)\nIP: 10.9.9.1 Password: 10.9.9.66 PIN: 4412 Serial number: SN9").map((button) => button.text)).toEqual(["10.9.9.1", "SN9"]);
  });

  it("caps at four, removes duplicates, and skips values over 256 characters", () => {
    const text = ["IP: 10.0.0.1", "IP: 10.0.0.1", "IP: 10.0.0.2", "Extension: 6722", `Serial number: ${"S".repeat(300)}`, "MAC: AA:BB:CC:DD:EE:FF", "PC name: HADX-PC01"].join("\n");
    expect(copyButtonsFor(text).map((button) => button.text)).toEqual(["10.0.0.1", "10.0.0.2", "6722", "AA:BB:CC:DD:EE:FF"]);
  });

  it("offers the IP from the equipment lookup", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    await handleText(deps, user, "Add equipment: Main switch, Server room, 192.168.1.2");
    const reply = await handleText(deps, user, "What's the IP of the main switch?");
    expect(reply.copyButtons).toEqual([{ label: "Copy IP 192.168.1.2", text: "192.168.1.2" }]);
  });
});

describe("copy buttons on RAG answers", () => {
  it("keeps only identifiers that are in both the answer and the retrieved records", async () => {
    const { deps, db } = testDeps();
    deps.llm = grokAnswering("Alex is on extension 6722. The backup line is 6799.");
    const user = await owner(db);
    await handleText(deps, user, "note this: HADX-PC01 6722 Alex");
    const reply = await answerWithRag(deps, user, "What is Alex's extension?");
    expect(reply?.text).toContain("6799");
    expect(reply?.copyButtons).toEqual([{ label: "Copy ext 6722", text: "6722" }]);
  });

  it("adds no button for an IP the model invented", async () => {
    expect(groundedCopyButtons("The printer is at 10.0.0.99.", "IP: 10.0.0.9\nSerial number: SN1")).toEqual([]);

    const { deps, db } = testDeps();
    deps.llm = grokAnswering("The floor 2 printer IP is 10.20.30.40.");
    const user = await owner(db);
    await handleText(deps, user, "note this: The floor 2 printer uses IP address 192.168.1.10.");
    const reply = await answerWithRag(deps, user, "What's the IP of the floor 2 printer?");
    expect(reply?.copyButtons).toBeUndefined();
  });
});

describe("rendering copy buttons", () => {
  function fakeCtx() {
    const sent: Array<{ text: string; markup: unknown }> = [];
    const ctx = {
      reply: async (text: string, other?: { reply_markup?: { inline_keyboard: unknown } }) => {
        sent.push({ text, markup: other?.reply_markup?.inline_keyboard });
        return { message_id: sent.length, chat: { id: 42 } };
      },
    };
    return { ctx: ctx as unknown as Context, sent };
  }

  it("puts copy buttons, one per row, before the confirm buttons", async () => {
    const { ctx, sent } = fakeCtx();
    await sendReply(ctx, { text: "Delete it?", keyboard: "confirm", copyButtons: [{ label: "Copy IP 10.0.0.1", text: "10.0.0.1" }, { label: "Copy ext 6722", text: "6722" }] });
    expect(sent[0]?.markup).toEqual([
      [{ text: "Copy IP 10.0.0.1", copy_text: { text: "10.0.0.1" } }],
      [{ text: "Copy ext 6722", copy_text: { text: "6722" } }],
      [{ text: "Confirm", callback_data: "c:yes" }, { text: "Cancel", callback_data: "c:no" }],
    ]);
  });

  it("puts copy buttons on the last chunk of a long reply", async () => {
    const { ctx, sent } = fakeCtx();
    await sendReply(ctx, { text: "x".repeat(9000), copyButtons: [{ label: "Copy IP 10.0.0.1", text: "10.0.0.1" }] });
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.slice(0, -1).every((part) => part.markup === undefined)).toBe(true);
    expect(sent.at(-1)?.markup).toEqual([[{ text: "Copy IP 10.0.0.1", copy_text: { text: "10.0.0.1" } }]]);
  });

  it("adds the copy buttons to the final edit of a streamed answer, not to previews", async () => {
    const edits: Array<{ text: string; markup: unknown }> = [];
    const ctx = {
      reply: async () => ({ message_id: 5, chat: { id: 42 } }),
      api: {
        editMessageText: async (_chat: number, _id: number, text: string, other?: { reply_markup?: { inline_keyboard: unknown } }) => {
          edits.push({ text, markup: other?.reply_markup?.inline_keyboard });
          return true;
        },
      },
    } as unknown as Context;
    const live = createLiveAnalysis(ctx, { minIntervalMs: 1_000 });
    await live.update("Searching…");
    expect(await live.finish({ text: "Alex is on extension 6722.", copyButtons: [{ label: "Copy ext 6722", text: "6722" }] })).toBe(true);
    expect(edits).toEqual([{ text: "Alex is on extension 6722.", markup: [[{ text: "Copy ext 6722", copy_text: { text: "6722" } }]] }]);
  });
});
