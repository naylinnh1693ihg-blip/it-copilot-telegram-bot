import type { Deps } from "../../app/deps.js";
import type { DocumentRecord, Extraction, User } from "../../types/models.js";
import { AppError } from "../../utils/errors.js";
import { redactString } from "../../utils/text.js";
import { toIso } from "../../utils/time.js";
import { indexSavedText } from "../rag/index.js";
import { extractImageText } from "./documentProcessor.js";
import { summarizeDocument } from "./grokSummarizer.js";
import { imageToVisionInput, pdfPagesForVision, shouldUseVision, type VisionImage } from "./vision.js";

/**
 * Photos and screenshots prefer the vision model.
 * OCR remains the indexed text in "both" mode, and the analysis source when vision is off or the vision call fails.
 * PDF and Office files with real extracted text stay on the text path.
 */
export async function analyzeStoredDocument(
  deps: Deps,
  user: User,
  document: DocumentRecord,
  extraction: Extraction | null,
  onPreview?: (plainText: string) => Promise<void>,
): Promise<{ text: string; parseMode?: "MarkdownV2" }> {
  const extracted = extraction?.text ?? "";
  const mode = deps.env.VISION_MODE;
  const image = document.mimeType.startsWith("image/");
  if (!shouldUseVision(document.mimeType, extracted, mode)) {
    if (image) deps.logger.info({ event: "image_read", route: "ocr", documentId: document.id }, "image analyzed from OCR");
    if (!extracted.trim()) return { text: `I stored document ${document.documentNumber}, but it has no extracted text to summarize.` };
    return finishAnalysis(deps, user, document, extracted, await summarizeDocument(deps, user, extracted, extraction?.truncated ?? false, [], "", onPreview));
  }

  try {
    const prepared = await prepareVisionImages(deps, document);
    deps.logger.info(
      { event: "image_read", route: mode === "vision" ? "vision" : "both", documentId: document.id },
      "image sent to vision",
    );
    return await finishAnalysis(
      deps,
      user,
      document,
      extracted,
      await summarizeDocument(deps, user, extracted, extraction?.truncated ?? false, prepared.images, prepared.note, onPreview),
    );
  } catch (error) {
    const message = redactString(error instanceof Error ? error.message : "vision failed");
    deps.logger.warn({ event: "image_read", route: "ocr", fallback: "vision_failed", documentId: document.id, message }, "vision failed; using OCR");
    const text = await ocrFallback(deps, user, document, extracted);
    if (!text.trim()) {
      if (error instanceof AppError) throw error;
      throw new AppError("I couldn't read this image with vision or OCR.");
    }
    return finishAnalysis(deps, user, document, text, await summarizeDocument(deps, user, text, extraction?.truncated ?? false, [], "", onPreview));
  }
}

async function finishAnalysis(
  deps: Deps,
  user: User,
  document: DocumentRecord,
  extracted: string,
  summary: { text: string; parseMode: "MarkdownV2"; notes: string[]; summary: string },
): Promise<{ text: string; parseMode: "MarkdownV2" }> {
  const notes = summary.notes.map((note) => `- ${note}`).join("\n");
  await indexSavedText(deps, {
    userId: user.id,
    source: "document",
    sourceId: document.id,
    sourceNumber: document.documentNumber,
    title: document.title,
    text: `${document.title}\n\nKey notes:\n${notes}\n\nSummary:\n${summary.summary}\n\n${extracted}`,
  });
  return { text: summary.text, parseMode: summary.parseMode };
}

async function prepareVisionImages(deps: Deps, document: DocumentRecord): Promise<{ images: VisionImage[]; note: string }> {
  const bytes = await deps.storage.download(document.storagePath);
  if (document.mimeType === "application/pdf") return pdfPagesForVision(bytes);
  return { images: [await imageToVisionInput(bytes)], note: "" };
}

async function ocrFallback(deps: Deps, user: User, document: DocumentRecord, extracted: string): Promise<string> {
  if (extracted.trim() || !document.mimeType.startsWith("image/")) return extracted;
  try {
    const bytes = await deps.storage.download(document.storagePath);
    const text = await extractImageText(bytes);
    if (!text.trim()) return "";
    await deps.db.saveExtraction({
      documentId: document.id,
      text,
      truncated: false,
      extractedAt: toIso(deps.clock.now()),
    });
    await indexSavedText(deps, {
      userId: user.id,
      source: "document",
      sourceId: document.id,
      sourceNumber: document.documentNumber,
      title: document.title,
      text: `${document.title}\n${text}`,
    });
    return text;
  } catch (error) {
    deps.logger.warn(
      { event: "image_read", route: "ocr", documentId: document.id, message: redactString(error instanceof Error ? error.message : "ocr failed") },
      "OCR fallback failed",
    );
    return "";
  }
}
