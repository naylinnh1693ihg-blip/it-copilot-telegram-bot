import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { saveDocument } from "../src/services/documents/documentService.js";
import { detectFile } from "../src/services/documents/files.js";
import { MemoryStorage } from "../src/services/documents/storage.js";
import { downloadTelegramFile } from "../src/services/documents/telegramDownload.js";
import { handleText } from "../src/services/assistant/handleText.js";
import { AppError } from "../src/utils/errors.js";
import { owner, testDeps } from "./helpers.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("documents", () => {
  it("rejects a mismatched file and stores a real spreadsheet that can be searched", async () => {
    const { deps, db, storage } = testDeps();
    const user = await owner(db);
    await expect(saveDocument(deps, user, { filename: "switch.pdf", declaredMime: "application/pdf", buffer: Buffer.from("hello") })).rejects.toBeInstanceOf(AppError);
    expect(storage.has(`${user.id}`)).toBe(false);

    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Network").addRows([["VLAN", "20"], ["name", "guest"], ["device, port", 'said "ok"']]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const saved = await saveDocument(deps, user, {
      filename: "vlan.xlsx",
      declaredMime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer,
      title: "Hotel VLAN sheet",
    });
    expect(saved.duplicate).toBe(false);
    expect(saved.text).toContain("VLAN");
    expect(saved.text).toContain('"device, port","said ""ok"""');
    const again = await saveDocument(deps, user, { filename: "copy.xlsx", declaredMime: "application/octet-stream", buffer, title: "copy" });
    expect(again.duplicate).toBe(true);
    const found = await handleText(deps, user, "Search my documents for VLAN");
    expect(found.text).toContain("Hotel VLAN sheet");
    const missing = await handleText(deps, user, "Search my documents for a firewall rule that was never saved");
    expect(missing.text).toContain("don't have");
  });

  it("stores a png and does not claim success when storage fails", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    const saved = await saveDocument(deps, user, { filename: "room.png", declaredMime: "image/png", buffer: PNG, title: "Room photo" });
    expect(saved.document.mimeType).toBe("image/png");
    expect(saved.text).toBe("");
    const failing = new MemoryStorage();
    failing.upload = async () => {
      throw new Error("bucket documents upload failed");
    };
    deps.storage = failing;
    await expect(saveDocument(deps, user, { filename: "note.txt", declaredMime: "text/plain", buffer: Buffer.from("switch port 4"), title: "port note" })).rejects.toThrow();
    expect(await db.listDocuments(user.id)).toHaveLength(1);
  });

  it("accepts the png signature and rejects a renamed text file", () => {
    expect(detectFile("photo.png", "image/png", PNG).kind).toBe("png");
    expect(() => detectFile("notes.txt", "text/plain", Buffer.from("safe\0binary"))).toThrow(AppError);
  });

  it("does not leak the bot token when a telegram download fails", async () => {
    const token = "123456:super-secret-token";
    const fetchImpl = async () => new Response(JSON.stringify({ ok: false, description: `bad token ${token}` }), { status: 400 });
    await expect(downloadTelegramFile({
      token,
      apiRoot: "https://api.telegram.org",
      fileId: "abc",
      maxBytes: 1024,
      fetchImpl: fetchImpl as typeof fetch,
    })).rejects.toThrow(/Nothing was stored/);
    try {
      await downloadTelegramFile({ token, apiRoot: "https://api.telegram.org", fileId: "abc", maxBytes: 20, fileSize: 100, fetchImpl: fetchImpl as typeof fetch });
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).userMessage).not.toContain(token);
    }
  });
});

describe("schema", () => {
  it("creates the private tables, full-text search, and locked reminder claim", () => {
    const sql = readFileSync(new URL("../supabase/migrations/20261030120000_initial_schema.sql", import.meta.url), "utf8");
    for (const table of ["users", "tasks", "reminders", "reminder_delivery_logs", "notes", "knowledge_entries", "documents", "document_extractions", "telegram_updates", "user_preferences", "audit_logs"]) {
      expect(sql).toContain(`create table ${table}`);
    }
    expect(sql).toContain("for update skip locked");
    expect(sql).toContain("enable row level security");
    expect(sql).toContain("documents");
    expect(sql).toContain("websearch_to_tsquery");
  });
});
