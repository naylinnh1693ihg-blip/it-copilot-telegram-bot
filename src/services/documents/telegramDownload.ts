import { effectiveUploadLimit, type Env } from "../../config/env.js";
import { AppError } from "../../utils/errors.js";

export function fileTooBigMessage(maxBytes: number): string {
  const mb = Math.floor(maxBytes / (1024 * 1024));
  return [
    `This file is larger than the ${mb} MB download limit. I did not store it.`,
    "Telegram's cloud Bot API at api.telegram.org lets a bot download files up to 20 MB.",
    "For a larger file, run your own Bot API server with `telegram-bot-api --local`. That mode removes the download limit and allows uploads up to 2000 MB.",
    "You can also send a smaller export, such as a PDF or spreadsheet.",
  ].join(" ");
}

interface TelegramFileResponse {
  ok?: boolean;
  description?: string;
  result?: { file_path?: string; file_size?: number };
}

export async function downloadTelegramFile(input: {
  token: string;
  apiRoot: string;
  fileId: string;
  fileSize?: number;
  maxBytes: number;
  fetchImpl?: typeof fetch;
}): Promise<Buffer> {
  const fetchImpl = input.fetchImpl ?? fetch;
  if (input.fileSize && input.fileSize > input.maxBytes) throw new AppError(fileTooBigMessage(input.maxBytes));
  const root = input.apiRoot.replace(/\/$/, "");
  const metaUrl = `${root}/bot${input.token}/getFile?file_id=${encodeURIComponent(input.fileId)}`;
  let meta: TelegramFileResponse;
  try {
    const response = await fetchImpl(metaUrl);
    meta = (await response.json()) as TelegramFileResponse;
  } catch {
    throw new AppError("I could not reach Telegram to download that file. Nothing was stored.");
  }
  const description = meta.description ?? "";
  if (!meta.ok || !meta.result?.file_path) {
    if (/too big/i.test(description)) throw new AppError(fileTooBigMessage(input.maxBytes));
    throw new AppError("Telegram could not provide that file. Nothing was stored.");
  }
  if (meta.result.file_path.startsWith("/") || meta.result.file_path.includes("..")) {
    throw new AppError("Telegram returned a local Bot API file path. This copilot does not read server file paths. Nothing was stored.");
  }
  if (meta.result.file_size && meta.result.file_size > input.maxBytes) {
    throw new AppError(fileTooBigMessage(input.maxBytes));
  }
  const fileUrl = `${root}/file/bot${input.token}/${meta.result.file_path}`;
  let bytes: Buffer;
  try {
    const response = await fetchImpl(fileUrl);
    if (!response.ok) throw new Error("bad status");
    bytes = Buffer.from(await response.arrayBuffer());
  } catch {
    throw new AppError("The file download from Telegram failed. Nothing was stored.");
  }
  if (bytes.length > input.maxBytes) throw new AppError(fileTooBigMessage(input.maxBytes));
  return bytes;
}

export function uploadLimit(env: Env): number {
  return effectiveUploadLimit(env);
}
