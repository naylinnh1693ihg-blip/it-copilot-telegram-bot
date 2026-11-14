import { randomInt } from "node:crypto";
import type { Context } from "grammy";
import type { Reply } from "../services/assistant/execute.js";
import type { AppLogger } from "../utils/logger.js";
import { redactString } from "../utils/text.js";
import { sendReply } from "./handlers/messages.js";
import { withoutAutoRetry } from "./telegramRetry.js";
import { createThrottledEdit, streamingWindow } from "./throttledEdit.js";

/** Telegram keeps a draft for about 30 seconds. Refresh well before that. */
export const DRAFT_REFRESH_MS = 20_000;
const REFRESH_CHECK_MS = 5_000;

/**
 * Status previews from handleText, RAG and the document summarizer. In a private chat the
 * draft's built-in "Thinking…" placeholder replaces them, and they are never partial answers.
 */
export const STATUS_PREVIEWS = new Set(["Working…", "Searching…", "Analyzing the document…"]);

/** Random non-zero 31-bit draft id. */
export function randomDraftId(): number {
  return randomInt(1, 2 ** 31);
}

export interface DraftStream {
  readonly draftId: number;
  /** Shows the "Thinking…" placeholder on first use, then the newest text (throttled). */
  update(plainText: string): Promise<void>;
  /** Sends the final reply as real messages. True only after Telegram accepted them. */
  finish(reply: Reply): Promise<boolean>;
  /** The newest answer text shown, for "(Stopped.)". Empty when only placeholders were shown. */
  partial(): string;
  /** Stops the refresh timer. Safe to call more than once. */
  close(): void;
}

/**
 * Streams a reply in a private chat with sendMessageDraft. The draft is a temporary preview;
 * finish() persists the answer with sendMessage (via sendReply, so long replies, keyboards
 * and copy buttons work as usual).
 */
export function createDraftStream(
  ctx: Context,
  chatId: number,
  options: { minIntervalMs: number; logger?: AppLogger; now?: () => number; draftId?: number },
): DraftStream {
  const now = options.now ?? (() => Date.now());
  const draftId = options.draftId ?? randomDraftId();
  let opened = false;
  let closed = false;
  let lastText = "";
  let lastSentAt = 0;
  let partialText = "";
  let timer: ReturnType<typeof setInterval> | undefined;

  // The throttled editor handles 429 itself, so auto-retry is skipped for drafts.
  const send = (text: string): Promise<void> =>
    withoutAutoRetry(async () => {
      await ctx.api.sendMessageDraft(chatId, draftId, text, { can_stop: true, keep_on_stop: true });
      lastText = text;
      lastSentAt = now();
    });

  const editor = createThrottledEdit({ minIntervalMs: options.minIntervalMs, log: options.logger, now, edit: send });

  const warn = (event: string, error: unknown): void => {
    options.logger?.warn({ event, message: redactString(error instanceof Error ? error.message : "draft failed") }, "telegram draft failed");
  };

  const refresh = (): void => {
    if (closed || !opened || now() - lastSentAt < DRAFT_REFRESH_MS) return;
    void send(lastText).catch((error: unknown) => warn("telegram_draft_refresh_failed", error));
  };

  const open = async (): Promise<void> => {
    if (opened || closed) return;
    opened = true;
    try {
      await send("");
    } catch (error) {
      warn("telegram_draft_failed", error);
    }
    timer = setInterval(refresh, REFRESH_CHECK_MS);
    timer.unref?.();
  };

  const close = (): void => {
    closed = true;
    if (timer) clearInterval(timer);
    timer = undefined;
  };

  return {
    draftId,
    async update(plainText) {
      if (closed) return;
      await open();
      if (STATUS_PREVIEWS.has(plainText.trim())) return;
      partialText = plainText;
      await editor.push(streamingWindow(plainText));
    },
    async finish(reply) {
      close();
      try {
        await sendReply(ctx, reply, options.logger);
        return true;
      } catch (error) {
        warn("telegram_final_send_failed", error);
        // A MarkdownV2 entity error must not lose the answer: send it as plain text.
        if (!reply.parseMode) return false;
        try {
          await sendReply(ctx, { ...reply, parseMode: undefined });
          return true;
        } catch (plainError) {
          warn("telegram_final_send_failed", plainError);
          return false;
        }
      }
    },
    partial() {
      return partialText.trim();
    },
    close,
  };
}

const inflight = new Map<string, AbortController>();

const generationKey = (chatId: number, draftId: number): string => `${chatId}:${draftId}`;

/** Registers a reply that the Stop button can cancel. Call release() when it settles. */
export function registerGeneration(chatId: number, draftId: number): { signal: AbortSignal; release(): void } {
  const key = generationKey(chatId, draftId);
  const controller = new AbortController();
  inflight.set(key, controller);
  return {
    signal: controller.signal,
    release() {
      if (inflight.get(key) === controller) inflight.delete(key);
    },
  };
}

/** Handles a stopped_message_generation update. False when no reply with that draft is running. */
export function stopGeneration(chatId: number, draftId: number): boolean {
  const controller = inflight.get(generationKey(chatId, draftId));
  if (!controller) return false;
  controller.abort();
  return true;
}

const chatQueues = new Map<number, Promise<void>>();

/**
 * Runs a private-chat reply after the previous one for that chat, without blocking the
 * update handler. Long polling handles one update at a time, so an awaited reply would hold
 * back the Stop button's update until the reply had finished. `task` must handle its own errors.
 */
export function runInChatQueue(chatId: number, task: () => Promise<void>): Promise<void> {
  const previous = chatQueues.get(chatId) ?? Promise.resolve();
  const next = previous.then(task, task);
  chatQueues.set(chatId, next);
  void next.finally(() => {
    if (chatQueues.get(chatId) === next) chatQueues.delete(chatId);
  });
  return next;
}

/** Resolves when every queued private-chat reply has finished. For tests and shutdown. */
export async function queuedRepliesSettled(): Promise<void> {
  while (chatQueues.size > 0) await Promise.allSettled([...chatQueues.values()]);
}
