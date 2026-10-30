import { createHash, randomUUID } from "node:crypto";
import type { Deps } from "../../app/deps.js";
import type { DocumentRecord, User } from "../../types/models.js";
import { AppError, DatabaseError } from "../../utils/errors.js";
import { cleanText } from "../../utils/text.js";
import { toIso } from "../../utils/time.js";
import { extractDocumentText } from "./extract.js";
import { detectFile } from "./files.js";
import { SIGNED_URL_SECONDS } from "./storage.js";
import { uploadLimit } from "./telegramDownload.js";

export interface SavedDocument {
  document: DocumentRecord;
  duplicate: boolean;
  text: string;
}

export async function saveDocument(
  deps: Deps,
  user: User,
  input: { filename: string; declaredMime: string; buffer: Buffer; title?: string; category?: string; tags?: string[] },
): Promise<SavedDocument> {
  if (input.buffer.length > uploadLimit(deps.env)) {
    throw new AppError(`This file is too large to store through the current Telegram connection. I did not store it.`);
  }
  const detected = detectFile(input.filename, input.declaredMime, input.buffer);
  const extracted = await extractDocumentText(detected.kind, input.buffer);
  const sha256 = createHash("sha256").update(input.buffer).digest("hex");
  const existing = await deps.db.findDocumentByHash(user.id, sha256);
  if (existing) return { document: existing, duplicate: true, text: (await deps.db.getExtraction(existing.id))?.text ?? "" };

  const id = randomUUID();
  const storagePath = `${user.id}/${id}/${id}.${detected.extension}`;
  try {
    await deps.storage.upload(storagePath, input.buffer, detected.mime);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new DatabaseError(error instanceof Error ? error.message : "Storage upload failed");
  }

  const now = toIso(deps.clock.now());
  let document: DocumentRecord;
  try {
    document = await deps.db.insertDocument({
      id,
      userId: user.id,
      title: cleanText(input.title || input.filename, 160),
      originalFilename: cleanText(input.filename, 180),
      storagePath,
      mimeType: detected.mime,
      byteSize: input.buffer.length,
      sha256,
      category: cleanText(input.category || "General", 80),
      tags: input.tags ?? [],
      createdAt: now,
    });
  } catch (error) {
    await deps.storage.remove(storagePath).catch(() => undefined);
    throw error;
  }

  await deps.db.saveExtraction({
    documentId: document.id,
    text: extracted.text,
    truncated: extracted.truncated,
    extractedAt: now,
  });
  return { document, duplicate: false, text: extracted.text };
}

export async function documentLink(deps: Deps, user: User, documentNumber: number): Promise<{ document: DocumentRecord; url: string }> {
  const document = await deps.db.findDocument(user.id, documentNumber);
  if (!document) throw new AppError(`I don't have document ${documentNumber}.`);
  const url = await deps.storage.signedUrl(document.storagePath, SIGNED_URL_SECONDS);
  return { document, url };
}
