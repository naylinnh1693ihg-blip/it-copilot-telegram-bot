import type { Context } from "grammy";
import type { Deps } from "../../app/deps.js";
import type { User } from "../../types/models.js";
import { chunkText } from "../../utils/text.js";
import { confirmKeyboard, mainMenu } from "../keyboards/menus.js";
import type { Reply } from "../../services/assistant/execute.js";

const users = new WeakMap<Context, User>();

export function rememberUser(ctx: Context, user: User): void {
  users.set(ctx, user);
}

export function currentUser(ctx: Context): User {
  const user = users.get(ctx);
  if (!user) throw new Error("The owner record was not loaded.");
  return user;
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
