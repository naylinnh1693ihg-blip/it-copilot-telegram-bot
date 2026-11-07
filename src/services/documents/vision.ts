import sharp from "sharp";
import { AppError } from "../../utils/errors.js";

/** Stay under xAI's 20 MiB per-image cap after JPEG compression. */
const TARGET_BYTES = 4 * 1024 * 1024;
const HARD_LIMIT_BYTES = 20 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
export const MAX_VISION_PAGES = 3;
const SCANNED_PDF_TEXT_LIMIT = 80;

export interface VisionImage {
  mime: "image/jpeg";
  data: Buffer;
}

export type VisionMode = "vision" | "ocr" | "both";

export function shouldUseVision(mimeType: string, extractedText: string, mode: VisionMode = "both"): boolean {
  if (mode === "ocr") return false;
  if (mimeType.startsWith("image/")) return true;
  return mimeType === "application/pdf" && extractedText.trim().length < SCANNED_PDF_TEXT_LIMIT;
}

export async function imageToVisionInput(buffer: Buffer): Promise<VisionImage> {
  if (buffer.length === 0) throw new AppError("The image is empty, so I did not send it to Grok.");
  let width = 2048;
  let quality = 82;
  let output = Buffer.alloc(0);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      output = await sharp(buffer, { limitInputPixels: MAX_PIXELS, failOn: "error" })
        .rotate()
        .resize({ width, height: width, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality })
        .toBuffer();
    } catch {
      throw new AppError("This image could not be prepared for Grok. I did not send it.");
    }
    if (output.length <= TARGET_BYTES) break;
    quality = Math.max(40, quality - 15);
    width = Math.floor(width * 0.75);
  }
  if (output.length === 0 || output.length > HARD_LIMIT_BYTES) {
    throw new AppError("This image is larger than Grok's 20 MB limit even after compression. I did not send it.");
  }
  return { mime: "image/jpeg", data: output };
}

export async function pdfPagesForVision(buffer: Buffer): Promise<{ images: VisionImage[]; note: string }> {
  let pdf: { numPages: number };
  let renderPageAsImage: (data: unknown, page: number, options: Record<string, unknown>) => Promise<ArrayBuffer>;
  try {
    const unpdf = await import("unpdf");
    pdf = await unpdf.getDocumentProxy(new Uint8Array(buffer));
    renderPageAsImage = unpdf.renderPageAsImage as typeof renderPageAsImage;
  } catch {
    throw new AppError("This scanned PDF could not be opened for image analysis. I did not send it to Grok.");
  }

  const total = pdf.numPages;
  if (!Number.isFinite(total) || total < 1) {
    throw new AppError("This PDF has no pages to show Grok.");
  }
  const count = Math.min(total, MAX_VISION_PAGES);
  const images: VisionImage[] = [];
  for (let page = 1; page <= count; page += 1) {
    let rendered: ArrayBuffer;
    try {
      rendered = await renderPageAsImage(pdf, page, {
        canvasImport: () => import("@napi-rs/canvas"),
        scale: 1.5,
      });
    } catch {
      throw new AppError("I couldn't render this PDF as an image for Grok. I did not invent a summary.");
    }
    images.push(await imageToVisionInput(Buffer.from(rendered)));
  }
  const note = total > count ? `Only the first ${count} of ${total} pages were sent as images.` : "";
  return { images, note };
}
