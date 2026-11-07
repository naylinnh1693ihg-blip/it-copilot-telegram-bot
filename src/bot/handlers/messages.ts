import type { Context } from "grammy";
import type { Deps } from "../../app/deps.js";
import type { User } from "../../types/models.js";
import type { AppLogger } from "../../utils/logger.js";
import { chunkText } from "../../utils/text.js";
import { confirmKeyboard, mainMenu } from "../keyboards/menus.js";
import type { Reply } from "../../services/assistant/execute.js";
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

export function createLiveAnalysis(
  ctx: Context,
  options: { minIntervalMs: number; logger?: AppLogger },
): {
  update(plainText: string): Promise<void>;
  finish(reply: Pick<Reply, "text" | "parseMode">): Promise<boolean>;
} {
  let messageId: number | undefined;
  let chatId: number | undefined;
  let parseMode: Reply["parseMode"];

  const editor = createThrottledEdit({
    minIntervalMs: options.minIntervalMs,
    log: options.logger,
    edit: async (text) => {
      if (!messageId || chatId === undefined) {
        const sent = await ctx.reply(text);
        messageId = sent.message_id;
        chatId = sent.chat.id;
        return;
      }
      if (!parseMode) {
        await ctx.api.editMessageText(chatId, messageId, text);
        return;
      }
      try {
        await ctx.api.editMessageText(chatId, messageId, text, { parse_mode: parseMode });
      } catch (error) {
        const failure = classifyTelegramEditError(error);
        if (failure.rateLimited || failure.notModified) throw error;
        await ctx.api.editMessageText(chatId, messageId, text);
      }
    },
  });

  return {
    update(plainText) {
      return editor.push(streamingWindow(plainText));
    },
    async finish(reply) {
      if (!messageId || chatId === undefined) return false;
      if (reply.text.length > TELEGRAM_MESSAGE_LIMIT) return false;
      parseMode = reply.parseMode;
      try {
        return await editor.flush(reply.text);
      } finally {
        parseMode = undefined;
      }
    },
  };
}

export async function sendReply(ctx: Context, reply: Reply): Promise<void> {
  const parts = chunkText(reply.text);
  for (let index = 0; index < parts.length; index += 1) {
    const markup = index === 0 ? (reply.keyboard === "menu" ? mainMenu() : reply.keyboard === "confirm" ? confirmKeyboard() : undefined) : undefined;
    await ctx.reply(parts[index] ?? "", {
      ...(markup ? { reply_markup: markup } : {}),
      ...(reply.parseMode ? { parse_mode: reply.parseMode } : {}),
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
