import { describe, expect, it, vi } from "vitest";
import type { Bot } from "grammy";
import type { Update } from "grammy/types";
import { ALLOWED_UPDATES, createBot, webhookOptions } from "../src/bot/index.js";
import { parseEnv } from "../src/config/env.js";
import { testDeps } from "./helpers.js";

const BOT_USER = { id: 999, is_bot: true, first_name: "Copilot", username: "copilot_bot" };

describe("ALLOWED_UPDATES", () => {
  it("lists only the update types the bot handles", () => {
    expect([...ALLOWED_UPDATES]).toEqual(["message", "callback_query", "my_chat_member", "stopped_message_generation"]);
  });
});

describe("webhookOptions", () => {
  it("sets the secret, allowed updates and max connections, and never drops pending updates", () => {
    const { deps } = testDeps({ TELEGRAM_WEBHOOK_MAX_CONNECTIONS: "25" });
    const options = webhookOptions(deps.env);
    expect(options.secret_token).toBe("hook_secret");
    expect(options.allowed_updates).toEqual(ALLOWED_UPDATES);
    expect(options.max_connections).toBe(25);
    expect(options).not.toHaveProperty("drop_pending_updates");
  });

  it("defaults max connections to 10", () => {
    const { deps } = testDeps();
    expect(webhookOptions(deps.env).max_connections).toBe(10);
  });

  it("rejects max connections outside 1-100", () => {
    for (const value of ["0", "101", "2.5", "many"]) {
      expect(() => parseEnv({ TELEGRAM_WEBHOOK_MAX_CONNECTIONS: value })).toThrow(/TELEGRAM_WEBHOOK_MAX_CONNECTIONS/);
    }
    expect(parseEnv({ TELEGRAM_WEBHOOK_MAX_CONNECTIONS: "1" }).TELEGRAM_WEBHOOK_MAX_CONNECTIONS).toBe(1);
    expect(parseEnv({ TELEGRAM_WEBHOOK_MAX_CONNECTIONS: "100" }).TELEGRAM_WEBHOOK_MAX_CONNECTIONS).toBe(100);
  });
});

function offlineBot() {
  const { deps, db } = testDeps();
  // A fresh logger per bot. Spying on the shared silentLogger would carry calls across tests.
  deps.logger = { info() {}, warn() {}, error() {}, debug() {} };
  const info = vi.spyOn(deps.logger, "info");
  const upsert = vi.spyOn(db, "upsertFromTelegram");
  const bot = createBot(deps.env.TELEGRAM_BOT_TOKEN, deps);
  bot.botInfo = { ...BOT_USER } as unknown as Bot["botInfo"];
  const calls: string[] = [];
  bot.api.config.use(async (_prev, method) => {
    calls.push(method);
    return { ok: true, result: true } as never;
  });
  return { bot, info, calls, upsert };
}

function membershipUpdate(updateId: number, fromId: number, chat: Record<string, unknown>, status: string): Update {
  return {
    update_id: updateId,
    my_chat_member: {
      chat,
      from: { id: fromId, is_bot: false, first_name: "Someone" },
      date: 0,
      old_chat_member: { status: "member", user: BOT_USER },
      new_chat_member: status === "kicked" ? { status, user: BOT_USER, until_date: 0 } : { status, user: BOT_USER },
    },
  } as unknown as Update;
}

describe("my_chat_member", () => {
  it("logs the owner's membership change without replying", async () => {
    const { bot, info, calls, upsert } = offlineBot();
    await bot.handleUpdate(membershipUpdate(1, 42, { id: 42, type: "private", first_name: "Owner" }, "kicked"));
    expect(calls).toEqual([]);
    expect(upsert).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith({ event: "bot_membership", status: "kicked", chatType: "private" }, "bot membership changed");
  });

  it("leaves, without replying, when a stranger adds the bot to a group", async () => {
    const { bot, info, calls } = offlineBot();
    await bot.handleUpdate(membershipUpdate(2, 7, { id: -100123, type: "group", title: "Team" }, "member"));
    expect(calls).toEqual(["leaveChat"]);
    expect(info).toHaveBeenCalledWith({ event: "bot_membership", status: "member", chatType: "group" }, "bot membership changed");
  });

  it("still replies to a stranger's message", async () => {
    const { bot, calls } = offlineBot();
    await bot.handleUpdate({
      update_id: 3,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: 7, type: "private", first_name: "Stranger" },
        from: { id: 7, is_bot: false, first_name: "Stranger" },
        text: "hi",
      },
    } as unknown as Update);
    expect(calls).toEqual(["sendMessage"]);
  });
});
