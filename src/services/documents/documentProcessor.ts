import mammoth from "mammoth";
import ExcelJS from "exceljs";
import sharp from "sharp";
import { createWorker } from "tesseract.js";
import { AppError } from "../../utils/errors.js";
import type { FileKind } from "./files.js";

/** Default stored extraction length. About 150_000 tokens, so long files can reach grok-4.20. */
export const DOCUMENT_EXTRACT_DEFAULT_CHARS = 600_000;
/** Absolute ceiling. Env values above this are ignored. */
export const DOCUMENT_EXTRACT_HARD_CAP_CHARS = 800_000;
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_OCR_EDGE = 3_000;

export type ImageTextRecognizer = (image: Buffer) => Promise<string>;

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

async function extractPdf(buffer: Buffer, maxChars: number): Promise<string> {
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const result = await extractText(pdf, { mergePages: false });
    const pages = Array.isArray(result.text) ? result.text : [String(result.text ?? "")];
    let text = "";
    for (const page of pages) {
      if (text.length >= maxChars) break;
      const piece = String(page);
      text += text ? `\n${piece}` : piece;
    }
    return text;
  } catch {
    throw new AppError("This PDF could not be read. I did not store it.");
  }
}

async function recognizeWithTesseract(image: Buffer): Promise<string> {
  const worker = await createWorker("eng");
  try {
    const result = await worker.recognize(image);
    return result.data.text;
  } finally {
    await worker.terminate();
  }
}

export async function extractImageText(buffer: Buffer, recognize: ImageTextRecognizer = recognizeWithTesseract): Promise<string> {
  let image: Buffer;
  try {
    image = await sharp(buffer, { limitInputPixels: MAX_IMAGE_PIXELS })
      .rotate()
      .resize({ width: MAX_OCR_EDGE, height: MAX_OCR_EDGE, fit: "inside", withoutEnlargement: true })
      .grayscale()
      .normalize()
      .png()
      .toBuffer();
  } catch {
    throw new AppError("This image is invalid or too large to process. I did not store it.");
  }
  try {
    return (await recognize(image)).trim();
  } catch {
    throw new AppError("Image text extraction failed. Please try a clearer image or upload it again.");
  }
}

function cleanExtractedText(input: string): string {
  return input
    .replaceAll("\0", "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractionCharLimit(requested?: number): number {
  const value = requested ?? DOCUMENT_EXTRACT_DEFAULT_CHARS;
  if (!Number.isFinite(value)) return DOCUMENT_EXTRACT_DEFAULT_CHARS;
  return Math.min(DOCUMENT_EXTRACT_HARD_CAP_CHARS, Math.max(10_000, Math.floor(value)));
}

function cutAtBoundary(window: string, edge: "start" | "end"): string {
  if (edge === "end") {
    const paragraph = window.lastIndexOf("\n\n");
    const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
    const cut = paragraph >= window.length * 0.5 ? paragraph : sentence >= window.length * 0.5 ? sentence + 1 : window.length;
    return window.slice(0, cut).trimEnd();
  }
  const paragraph = window.indexOf("\n\n");
  const sentenceAt = [". ", "! ", "? "].map((mark) => window.indexOf(mark)).filter((index) => index >= 0);
  const sentence = sentenceAt.length > 0 ? Math.min(...sentenceAt) : -1;
  const cut = paragraph !== -1 && paragraph <= window.length * 0.5 ? paragraph + 2 : sentence !== -1 && sentence <= window.length * 0.5 ? sentence + 2 : 0;
  return window.slice(cut).trimStart();
}

function truncateExtractedText(text: string, maxChars: number): string {
  const marker = "\n[Middle of extracted text omitted because the document is exceptionally long.]\n";
  const available = Math.max(marker.length + 2, maxChars - marker.length);
  const headBudget = Math.max(1, Math.floor(available * 0.7));
  const tailBudget = Math.max(1, available - headBudget);
  const head = cutAtBoundary(text.slice(0, headBudget), "end");
  const tail = cutAtBoundary(text.slice(text.length - tailBudget), "start");
  return `${head}${marker}${tail}`;
}

export async function extractDocumentText(
  kind: FileKind,
  buffer: Buffer,
  options: { recognizeImage?: ImageTextRecognizer; maxChars?: number } = {},
): Promise<{ text: string; truncated: boolean }> {
  const maxChars = extractionCharLimit(options.maxChars);
  let text = "";
  if (kind === "txt" || kind === "csv") {
    const byteCap = (maxChars + 1) * 4;
    if (buffer.length > byteCap) {
      const headBytes = Math.floor(byteCap * 0.7);
      const tailBytes = byteCap - headBytes;
      text = `${buffer.subarray(0, headBytes).toString("utf8")}\n${buffer.subarray(buffer.length - tailBytes).toString("utf8")}`;
    } else {
      text = buffer.toString("utf8");
    }
  } else if (kind === "pdf") {
    text = await extractPdf(buffer, maxChars);
  } else if (kind === "docx") {
    try {
      const result = await mammoth.extractRawText({ buffer });
      text = result.value;
    } catch {
      throw new AppError("This DOCX file could not be read. I did not store it.");
    }
  } else if (kind === "xlsx") {
    try {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(Uint8Array.from(buffer).buffer);
      if (workbook.worksheets.length === 0) throw new AppError("This spreadsheet has no sheets. I did not store it.");
      const sheets: string[] = [];
      for (const sheet of workbook.worksheets) {
        const rows: string[] = [];
        sheet.eachRow((row) => {
          if (sheets.join("\n").length + rows.join("\n").length >= maxChars) return;
          const fields = Array.from({ length: row.cellCount }, (_, index) => csvField(row.getCell(index + 1).text));
          rows.push(fields.join(","));
        });
        sheets.push(rows.join("\n"));
        if (sheets.join("\n").length >= maxChars) break;
      }
      text = sheets.join("\n");
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("This XLSX file could not be read. I did not store it.");
    }
  } else if (kind === "jpg" || kind === "png" || kind === "webp") {
    text = await extractImageText(buffer, options.recognizeImage);
  }
  const cleaned = cleanExtractedText(text);
  return {
    text: cleaned.length > maxChars ? truncateExtractedText(cleaned, maxChars) : cleaned,
    truncated: cleaned.length > maxChars,
  };
}
