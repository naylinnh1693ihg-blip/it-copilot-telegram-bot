import type { Context } from "grammy";
import type { Deps } from "../../app/deps.js";
import type { User } from "../../types/models.js";
import type { AppLogger } from "../../utils/logger.js";
import { chunkText, redactString } from "../../utils/text.js";
import { replyKeyboard } from "../keyboards/menus.js";
import type { InlineKeyboard } from "grammy";
import type { EphemeralMessageParameters } from "grammy/types";
import type { Reply } from "../../services/assistant/execute.js";
import { withoutAutoRetry } from "../telegramRetry.js";
import { classifyTelegramEditError, createThrottledEdit, streamingWindow, TELEGRAM_MESSAGE_LIMIT } from "../throttledEdit.js";

const users = new WeakMap<Context, User>();

export function rememberUser(ctx: Context, user: User): void {
  users.set(ctx, user);
}

export function currentUser(ctx: Context): User {
  const user = users.get(ctx);
  if (!user) throw new Error("The owner record was not loaded.");
  return user;
}

export type ChatAction = "typing" | "upload_document" | "upload_photo";

/** Telegram clears a chat action after about five seconds, so it is refreshed this often. */
export const CHAT_ACTION_REFRESH_MS = 4_000;

/**
 * Shows "typing…", "sending file…" or "sending photo…" until stop() is called.
 * Long model calls and file downloads take longer than one action lasts.
 */
export function keepChatAction(
  ctx: Pick<Context, "chat" | "replyWithChatAction">,
  action: ChatAction = "typing",
): { stop(): void } {
  let stopped = false;
  const send = (): void => {
    if (stopped || ctx.chat === undefined) return;
    void ctx.replyWithChatAction(action).catch(() => undefined);
  };
  send();
  const timer = setInterval(send, CHAT_ACTION_REFRESH_MS);
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

export function createLiveAnalysis(
  ctx: Context,
  options: { minIntervalMs: number; logger?: AppLogger },
): {
  update(plainText: string): Promise<void>;
  finish(reply: Pick<Reply, "text" | "parseMode" | "keyboard" | "copyButtons" | "richMarkdown" | "lookup">): Promise<boolean>;
} {
  let messageId: number | undefined;
  let chatId: number | undefined;
  let parseMode: Reply["parseMode"];
  // Set only for the final edit, so the copy buttons appear with the finished answer.
  let markup: InlineKeyboard | undefined;

  const editor = createThrottledEdit({
    minIntervalMs: options.minIntervalMs,
    log: options.logger,
    // Previews skip auto-retry: the throttled editor drops a rate-limited preview instead of waiting.
    edit: (text) => withoutAutoRetry(async () => {
      if (!messageId || chatId === undefined) {
        const sent = await ctx.reply(text);
        // message_id 0 means an ephemeral or scheduled message, which can't be edited; never keep it.
        if (sent.message_id === 0) return;
        messageId = sent.message_id;
        chatId = sent.chat.id;
        return;
      }
      const keyboard = markup ? { reply_markup: markup } : {};
      if (!parseMode) {
        await ctx.api.editMessageText(chatId, messageId, text, keyboard);
        return;
      }
      try {
        await ctx.api.editMessageText(chatId, messageId, text, { parse_mode: parseMode, ...keyboard });
      } catch (error) {
        const failure = classifyTelegramEditError(error);
        if (failure.rateLimited || failure.notModified) throw error;
        await ctx.api.editMessageText(chatId, messageId, text, keyboard);
      }
    }),
  });

  return {
    update(plainText) {
      return editor.push(streamingWindow(plainText));
    },
    async finish(reply) {
      if (!messageId || chatId === undefined) return false;
      if (reply.richMarkdown || ephemeralTarget(ctx, reply)) {
        // A text preview can't be edited into a rich or ephemeral message (and an ephemeral
        // answer must not stay visible to the group). Remove it; the caller sends
        // the rich reply as a new message.
        const id = messageId;
        const chat = chatId;
        await withoutAutoRetry(() => ctx.api.deleteMessage(chat, id)).catch(() => undefined);
        return false;
      }
      if (reply.text.length > TELEGRAM_MESSAGE_LIMIT) return false;
      parseMode = reply.parseMode;
      markup = reply.copyButtons?.length ? replyKeyboard(reply) : undefined;
      try {
        return await editor.flush(reply.text);
      } finally {
        parseMode = undefined;
        markup = undefined;
      }
    },
  };
}

/**
 * Ephemeral parameters for a lookup answered in the team group: only the asker sees it.
 * A button tap replaces the tapped message for that user only. Null for everything else,
 * including every private chat and every reply that is not marked as a lookup.
 */
export function ephemeralTarget(ctx: Context, reply: Pick<Reply, "lookup">): EphemeralMessageParameters | null {
  const type = ctx.chat?.type;
  if (!reply.lookup || (type !== "group" && type !== "supergroup") || !ctx.from) return null;
  return {
    receiver_user_id: ctx.from.id,
    ...(ctx.callbackQuery ? { callback_query_id: ctx.callbackQuery.id, replace_callback_query_message: true } : {}),
  };
}

/** A Bot API "400 Bad Request", such as a rich message Telegram could not parse. */
function isBadRequest(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { error_code?: unknown }).error_code === 400;
}

export async function sendReply(
  ctx: Context,
  reply: Reply,
  logger?: AppLogger,
  options: { ephemeral?: EphemeralMessageParameters } = {},
): Promise<void> {
  // Only the first message may replace the tapped one; later chunks are still for the asker only.
  const ephemeralFor = (index: number) => {
    if (!options.ephemeral) return {};
    const { callback_query_id: _id, replace_callback_query_message: _replace, ...rest } = options.ephemeral;
    return { ephemeral_message_parameters: index === 0 ? options.ephemeral : rest };
  };
  if (reply.richMarkdown) {
    try {
      const keyboard = replyKeyboard(reply);
      // One rich message (up to 32768 characters) instead of 4096-character chunks.
      await ctx.replyWithRichMessage(
        { markdown: reply.richMarkdown },
        keyboard || options.ephemeral ? { ...(keyboard ? { reply_markup: keyboard } : {}), ...ephemeralFor(0) } : undefined,
      );
      return;
    } catch (error) {
      if (!isBadRequest(error)) throw error;
      logger?.warn(
        { event: "rich_message_rejected", message: redactString(error instanceof Error ? error.message : "rich message rejected") },
        "rich message rejected; sending plain text",
      );
    }
  }
  const parts = chunkText(reply.text);
  const keyboard = replyKeyboard(reply);
  // Copy buttons belong under the text they copy from, so a long reply carries them on its
  // last chunk. Without copy buttons the menu or confirm keyboard stays on the first chunk.
  const keyboardAt = reply.copyButtons?.length ? parts.length - 1 : 0;
  for (let index = 0; index < parts.length; index += 1) {
    const markup = index === keyboardAt ? keyboard : undefined;
    await ctx.reply(parts[index] ?? "", {
      ...(markup ? { reply_markup: markup } : {}),
      ...(reply.parseMode ? { parse_mode: reply.parseMode } : {}),
      ...ephemeralFor(index),
    });
  }
}

export function buildStatus(deps: Deps, database: "reachable" | "not reachable"): string {
  return [
    "IT Work Copilot",
    `Time zone: ${deps.env.APP_TIMEZONE}`,
    `Database: ${database}`,
    deps.llm ? `Grok: configured (${deps.env.XAI_MODEL})` : "Grok: not configured",
    `Telegram mode: ${deps.env.TELEGRAM_MODE}`,
    `Reminder worker: ${deps.env.REMINDER_POLL_MS > 0 ? `every ${deps.env.REMINDER_POLL_MS} ms` : "HTTP endpoint only"}`,
  ].join("\n");
}
