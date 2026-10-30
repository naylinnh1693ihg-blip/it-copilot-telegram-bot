import mammoth from "mammoth";
import ExcelJS from "exceljs";
import { AppError } from "../../utils/errors.js";
import type { FileKind } from "./files.js";

const MAX_TEXT = 100_000;

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

export async function extractDocumentText(kind: FileKind, buffer: Buffer): Promise<{ text: string; truncated: boolean }> {
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
  }
  const cleaned = text.split(String.fromCharCode(0)).join("").trim();
  return { text: cleaned.slice(0, MAX_TEXT), truncated: cleaned.length > MAX_TEXT };
}
