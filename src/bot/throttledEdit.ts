import type { AppLogger } from "../utils/logger.js";

/** Telegram rejects edits longer than this. */
export const TELEGRAM_MESSAGE_LIMIT = 4096;
/** Preview window, leaving room for an ellipsis. */
export const TELEGRAM_STREAM_WINDOW = 3900;

export interface TelegramEditFailure {
  rateLimited: boolean;
  notModified: boolean;
  retryAfterSeconds: number | null;
}

export function classifyTelegramEditError(error: unknown): TelegramEditFailure {
  const row = error && typeof error === "object" ? (error as { error_code?: number; description?: string; message?: string; parameters?: { retry_after?: number } }) : {};
  const description = `${row.description ?? ""} ${row.message ?? ""}`.toLowerCase();
  const retryAfter = typeof row.parameters?.retry_after === "number" && row.parameters.retry_after > 0 ? row.parameters.retry_after : null;
  const notModified = description.includes("message is not modified");
  const rateLimited = row.error_code === 429 || description.includes("too many requests") || retryAfter !== null;
  return { rateLimited: rateLimited && !notModified, notModified, retryAfterSeconds: retryAfter };
}

/** Latest slice that fits in a streaming edit. The final reply is sent separately when it is longer. */
export function streamingWindow(text: string, limit = TELEGRAM_STREAM_WINDOW): string {
  const value = text.trim();
  if (value.length <= limit) return value;
  return `…${value.slice(-(limit - 1))}`;
}

export interface ThrottledEdit {
  /** Keep the newest text and edit only when the interval allows. */
  push(text: string): Promise<void>;
  /** Edit the finished text even if the interval has not elapsed. False means the caller should send it instead. */
  flush(text: string): Promise<boolean>;
}

export function createThrottledEdit(options: {
  minIntervalMs: number;
  edit: (text: string) => Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: AppLogger;
}): ThrottledEdit {
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const interval = Math.max(1_000, options.minIntervalMs);
  let latest = "";
  let lastSent = "";
  let lastEditAt = 0;
  let blockedUntil = 0;
  let opened = false;
  let loggedSkip = false;
  let chain = Promise.resolve();

  const enqueue = (task: () => Promise<void>): Promise<void> => {
    chain = chain.then(task, task);
    return chain;
  };

  const noteSkip = (reason: "throttle" | "retry_after"): void => {
    if (loggedSkip) return;
    loggedSkip = true;
    options.log?.info({ event: "telegram_edit_skipped", reason }, "telegram edit skipped");
  };

  const attempt = async (text: string): Promise<"ok" | "retry" | "fail"> => {
    try {
      await options.edit(text);
      return "ok";
    } catch (error) {
      const failure = classifyTelegramEditError(error);
      if (failure.notModified) return "ok";
      if (failure.rateLimited) {
        const seconds = failure.retryAfterSeconds ?? 1;
        blockedUntil = now() + seconds * 1000;
        options.log?.warn({ event: "telegram_edit_limited", retryAfter: seconds }, "telegram edit rate limited");
        return "retry";
      }
      options.log?.warn({ event: "telegram_edit_failed" }, "telegram edit failed");
      return "fail";
    }
  };

  const markSent = (text: string): void => {
    lastSent = text;
    lastEditAt = now();
    opened = true;
    loggedSkip = false;
  };

  return {
    push(text) {
      latest = text;
      return enqueue(async () => {
        const current = latest;
        if (!current || current === lastSent) return;
        const time = now();
        if (time < blockedUntil) {
          noteSkip("retry_after");
          return;
        }
        if (opened && time - lastEditAt < interval) {
          noteSkip("throttle");
          return;
        }
        const result = await attempt(current);
        if (result === "ok") markSent(current);
      });
    },
    async flush(text) {
      await chain;
      if (text.length > TELEGRAM_MESSAGE_LIMIT) return false;
      const pause = blockedUntil - now();
      if (pause > 0) await sleep(pause);
      let result = await attempt(text);
      if (result === "retry") {
        const wait = Math.max(0, blockedUntil - now());
        if (wait > 0) await sleep(wait);
        result = await attempt(text);
      }
      if (result === "ok") {
        markSent(text);
        return true;
      }
      return false;
    },
  };
}
