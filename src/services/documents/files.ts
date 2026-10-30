import { AppError } from "../../utils/errors.js";

export type FileKind = "pdf" | "docx" | "xlsx" | "csv" | "txt" | "jpg" | "png";

const MIME: Record<FileKind, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  txt: "text/plain",
  jpg: "image/jpeg",
  png: "image/png",
};

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function extensionOf(filename: string): string {
  const clean = filename.split(/[/\\]/).pop() ?? "";
  const parts = clean.toLowerCase().split(".");
  return parts.length > 1 ? parts[parts.length - 1] ?? "" : "";
}

function looksLike(kind: FileKind, buffer: Buffer): boolean {
  if (kind === "pdf") return buffer.subarray(0, 4).toString("utf8") === "%PDF";
  if (kind === "png") return buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG);
  if (kind === "jpg") return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (kind === "docx" || kind === "xlsx") return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
  if (kind === "txt" || kind === "csv") return !buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0);
  return false;
}

function kindFrom(filename: string, mime: string, buffer: Buffer): FileKind | null {
  const extension = extensionOf(filename);
  const normalized = mime.toLowerCase();
  if (extension === "pdf" || normalized === "application/pdf") return "pdf";
  if (extension === "docx" || normalized.includes("wordprocessingml")) return "docx";
  if (extension === "xlsx" || normalized.includes("spreadsheetml")) return "xlsx";
  if (extension === "csv" || normalized === "text/csv") return "csv";
  if (extension === "txt" || normalized === "text/plain") return "txt";
  if (extension === "jpg" || extension === "jpeg" || normalized === "image/jpeg") return "jpg";
  if (extension === "png" || normalized === "image/png") return "png";
  if (normalized === "application/octet-stream" || normalized === "") {
    if (looksLike("pdf", buffer)) return "pdf";
    if (looksLike("png", buffer)) return "png";
    if (looksLike("jpg", buffer)) return "jpg";
  }
  return null;
}

export function detectFile(filename: string, mime: string, buffer: Buffer): { kind: FileKind; mime: string; extension: string } {
  if (buffer.length === 0) throw new AppError("The file is empty, so I did not store it.");
  const kind = kindFrom(filename, mime, buffer);
  if (!kind) {
    throw new AppError("I can store PDF, DOCX, XLSX, CSV, TXT, JPG, and PNG files. This file is not one of those, so I did not store it.");
  }
  if (!looksLike(kind, buffer)) {
    throw new AppError(`This file is labeled as a ${kind.toUpperCase()}, but the contents do not match. I did not store it.`);
  }
  const extension = kind === "jpg" ? "jpg" : kind;
  return { kind, mime: MIME[kind], extension };
}
