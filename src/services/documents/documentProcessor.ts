import mammoth from "mammoth";
import ExcelJS from "exceljs";
import sharp from "sharp";
import { createWorker } from "tesseract.js";
import { AppError } from "../../utils/errors.js";
import type { FileKind } from "./files.js";

const MAX_TEXT = 100_000;
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_OCR_EDGE = 3_000;

export type ImageTextRecognizer = (image: Buffer) => Promise<string>;

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

async function extractPdf(buffer: Buffer): Promise<string> {
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const result = await extractText(pdf, { mergePages: true });
    return Array.isArray(result.text) ? result.text.join("\n") : String(result.text ?? "");
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

function truncateExtractedText(text: string): string {
  const marker = "\n[Middle of extracted text omitted because the document is exceptionally long.]\n";
  const available = MAX_TEXT - marker.length;
  const headEnd = Math.floor(available * 0.7);
  const tailStart = text.length - (available - headEnd);
  return `${text.slice(0, headEnd).trimEnd()}${marker}${text.slice(tailStart).trimStart()}`;
}

export async function extractDocumentText(
  kind: FileKind,
  buffer: Buffer,
  options: { recognizeImage?: ImageTextRecognizer } = {},
): Promise<{ text: string; truncated: boolean }> {
  let text = "";
  if (kind === "txt" || kind === "csv") {
    text = buffer.toString("utf8");
  } else if (kind === "pdf") {
    text = await extractPdf(buffer);
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
      text = workbook.worksheets.map((sheet) => {
        const rows: string[] = [];
        sheet.eachRow((row) => {
          const fields = Array.from({ length: row.cellCount }, (_, index) => csvField(row.getCell(index + 1).text));
          rows.push(fields.join(","));
        });
        return rows.join("\n");
      }).join("\n");
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("This XLSX file could not be read. I did not store it.");
    }
  } else if (kind === "jpg" || kind === "png" || kind === "webp") {
    text = await extractImageText(buffer, options.recognizeImage);
  }
  const cleaned = cleanExtractedText(text);
  return {
    text: cleaned.length > MAX_TEXT ? truncateExtractedText(cleaned) : cleaned,
    truncated: cleaned.length > MAX_TEXT,
  };
}
