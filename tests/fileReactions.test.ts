import type { Context } from "grammy";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rememberUser } from "../src/bot/handlers/messages.js";
import { safeReact, storeFile } from "../src/bot/index.js";
import type { DocumentRecord } from "../src/types/models.js";
import { AppError } from "../src/utils/errors.js";
import { owner, testDeps } from "./helpers.js";

const saveDocument = vi.hoisted(() => vi.fn());
vi.mock("../src/services/documents/telegramDownload.js", async (original) => ({
  ...(await original<typeof import("../src/services/documents/telegramDownload.js")>()),
  downloadTelegramFile: vi.fn(async () => Buffer.from("file body")),
}));
vi.mock("../src/services/documents/documentService.js", async (original) => ({
  ...(await original<typeof import("../src/services/documents/documentService.js")>()),
  saveDocument,
}));

const FILE = { fileId: "file-1", filename: "switch.pdf", mime: "application/pdf", action: "upload_document" as const };

function savedDocument(): DocumentRecord {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    userId: "user",
    documentNumber: 4,
    title: "switch.pdf",
    originalFilename: "switch.pdf",
    storagePath: "user/doc.pdf",
    mimeType: "application/pdf",
    byteSize: 9,
    sha256: "hash",
    category: "General",
    tags: [],
    createdAt: "2026-10-30T06:00:00.000Z",
    deletedAt: null,
  };
}

async function setup(options: { reactFails?: boolean } = {}) {
  const { deps, db } = testDeps();
  const warnings: Array<Record<string, unknown>> = [];
  deps.logger = { info() {}, warn(obj) { warnings.push(obj); }, error() {}, debug() {} };
  const user = await owner(db);
  const reactions: unknown[] = [];
  const replies: string[] = [];
  const ctx = {
    chat: { id: 42, type: "private", first_name: "Owner" },
    replyWithChatAction: async () => true,
    react: async (reaction: unknown) => {
      reactions.push(reaction);
      if (options.reactFails) throw new Error("Network request for 'setMessageReaction' failed! https://api.telegram.org/bot123456:test-token-value/setMessageReaction");
      return true;
    },
    reply: async (text: string) => {
      replies.push(text);
      return { message_id: replies.length, chat: { id: 42 } };
    },
  } as unknown as Context;
  rememberUser(ctx, user);
  return { deps, ctx, reactions, replies, warnings };
}

describe("file reactions", () => {
  beforeEach(() => {
    saveDocument.mockReset();
  });

  it("reacts 👀 then 👍 and still sends the Stored document reply", async () => {
    saveDocument.mockResolvedValue({ document: savedDocument(), duplicate: false, text: "VLAN 20" });
    const { deps, ctx, reactions, replies } = await setup();
    await storeFile(deps, ctx, FILE);
    expect(reactions).toEqual(["👀", "👍"]);
    expect(replies).toEqual(["Stored document 4: switch.pdf."]);
  });

  it("reacts 👌 for a file that was already saved", async () => {
    saveDocument.mockResolvedValue({ document: savedDocument(), duplicate: true, text: "VLAN 20" });
    const { deps, ctx, reactions, replies } = await setup();
    await storeFile(deps, ctx, FILE);
    expect(reactions).toEqual(["👀", "👌"]);
    expect(replies[0]).toContain("You already saved this file as document 4");
  });

  it("clears the reaction and sends the error when saving fails", async () => {
    saveDocument.mockRejectedValue(new AppError("That file is too large to save."));
    const { deps, ctx, reactions, replies } = await setup();
    await storeFile(deps, ctx, FILE);
    expect(reactions).toEqual(["👀", []]);
    expect(reactions).not.toContain("👍");
    expect(replies).toEqual(["That file is too large to save."]);
  });

  it("still saves the file and replies when reactions fail, and logs a redacted warning", async () => {
    saveDocument.mockResolvedValue({ document: savedDocument(), duplicate: false, text: "VLAN 20" });
    const { deps, ctx, reactions, replies, warnings } = await setup({ reactFails: true });
    await storeFile(deps, ctx, FILE);
    expect(saveDocument).toHaveBeenCalledTimes(1);
    expect(reactions).toEqual(["👀", "👍"]);
    expect(replies).toEqual(["Stored document 4: switch.pdf."]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]?.event).toBe("telegram_reaction_failed");
    expect(JSON.stringify(warnings)).not.toContain("test-token-value");
  });

  it("safeReact never throws", async () => {
    const ctx = { react: async () => Promise.reject("not an Error") } as unknown as Context;
    await expect(safeReact(ctx, "👀", testDeps().deps.logger)).resolves.toBeUndefined();
  });
});
