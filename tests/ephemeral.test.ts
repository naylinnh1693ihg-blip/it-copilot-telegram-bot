import { Context, type Bot } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { describe, expect, it } from "vitest";
import { queuedRepliesSettled } from "../src/bot/draftStream.js";
import { createLiveAnalysis } from "../src/bot/handlers/messages.js";
import { createBot } from "../src/bot/index.js";
import { processDueReminders } from "../src/jobs/processReminders.js";
import { fixedClock } from "../src/utils/time.js";
import { testDeps } from "./helpers.js";

const OWNER = 42;
const MEMBER = 77;
const TEAM_CHAT = -100555;
const TOPIC = 12;
const ME = { id: 999, is_bot: true, first_name: "Copilot", username: "copilot_bot" } as UserFromGetMe;
const teamGroup = { id: TEAM_CHAT, type: "supergroup", title: "IT team", is_forum: true };
const privateChat = (id: number) => ({ id, type: "private", first_name: `User${id}` });

type Call = { method: string; payload: Record<string, unknown> };

function teamBot(options: { env?: Record<string, string>; ephemeralFails?: boolean } = {}) {
  const setup = testDeps({ TELEGRAM_TEAM_IDS: String(MEMBER), TELEGRAM_TEAM_CHAT_ID: String(TEAM_CHAT), ...options.env });
  const bot = createBot(setup.deps.env.TELEGRAM_BOT_TOKEN, setup.deps);
  bot.botInfo = ME as Bot["botInfo"];
  const calls: Call[] = [];
  bot.api.config.use(async (_prev, method, raw) => {
    const payload = raw as Record<string, unknown>;
    calls.push({ method, payload });
    const ephemeral = payload.ephemeral_message_parameters !== undefined;
    if (ephemeral && options.ephemeralFails) {
      return { ok: false, error_code: 400, description: "Bad Request: EPHEMERAL_MESSAGES_UNSUPPORTED" } as never;
    }
    const chat = { id: Number(payload.chat_id ?? 0), type: Number(payload.chat_id) > 0 ? "private" : "supergroup" };
    // Telegram returns message_id 0 for an ephemeral message.
    const result = method === "sendMessage" || method === "sendRichMessage" ? { message_id: ephemeral ? 0 : calls.length, date: 0, chat, text: "" } : true;
    return { ok: true, result } as never;
  });
  let updateId = 0;
  const message = async (from: number, chat: Record<string, unknown>, text: string, topic?: number) => {
    updateId += 1;
    await bot.handleUpdate({
      update_id: updateId,
      message: {
        message_id: updateId,
        date: 0,
        chat,
        from: { id: from, is_bot: false, first_name: `User${from}` },
        text,
        ...(text.startsWith("/") ? { entities: [{ type: "bot_command", offset: 0, length: text.split(/\s/)[0]?.length ?? 1 }] } : {}),
        ...(topic ? { is_topic_message: true, message_thread_id: topic } : {}),
      },
    } as unknown as Update);
    await queuedRepliesSettled();
  };
  const tap = async (from: number, data: string) => {
    updateId += 1;
    await bot.handleUpdate({
      update_id: updateId,
      callback_query: {
        id: `cb-${updateId}`,
        from: { id: from, is_bot: false, first_name: `User${from}` },
        chat_instance: "x",
        data,
        message: { message_id: 500, date: 0, chat: teamGroup, text: "menu" },
      },
    } as unknown as Update);
  };
  const sends = () => calls.filter((call) => call.method === "sendMessage" || call.method === "sendRichMessage").map((call) => call.payload);
  const ephemeralSends = () => sends().filter((payload) => payload.ephemeral_message_parameters !== undefined);
  return { ...setup, bot, calls, message, tap, sends, ephemeralSends };
}

describe("ephemeral lookups in the team group", () => {
  it("sends a lookup only to the asker, in the same topic, and nothing public", async () => {
    const { message, sends, ephemeralSends, calls } = teamBot();
    await message(MEMBER, privateChat(MEMBER), "note this: Alex is on extension 6722.");
    const before = calls.length;
    await message(MEMBER, teamGroup, "@copilot_bot what did I save about Alex", TOPIC);

    const answer = ephemeralSends().at(-1);
    expect(answer?.ephemeral_message_parameters).toEqual({ receiver_user_id: MEMBER });
    expect(answer?.chat_id).toBe(TEAM_CHAT);
    expect(answer?.message_thread_id).toBe(TOPIC);
    expect(String(answer?.text)).toContain("6722");
    const publicTexts = sends().slice(0).filter((payload) => payload.chat_id === TEAM_CHAT && !payload.ephemeral_message_parameters).map((payload) => String(payload.text));
    expect(publicTexts.some((text) => text.includes("6722"))).toBe(false);
    expect(calls.slice(before).some((call) => call.method === "sendMessage" && call.payload.text === "Sent you the answer privately 👀")).toBe(false);
  });

  it("sends equipment lookups ephemerally too", async () => {
    const { message, ephemeralSends } = teamBot();
    await message(MEMBER, privateChat(MEMBER), "Add equipment: Main switch, Server room, 192.168.1.2");
    await message(MEMBER, teamGroup, "@copilot_bot what's the IP of the main switch?");
    expect(String(ephemeralSends().at(-1)?.text)).toContain("192.168.1.2");
  });

  it("replaces the tapped menu message for that user only", async () => {
    const { tap, ephemeralSends } = teamBot();
    await tap(MEMBER, "m:notes");
    expect(ephemeralSends().at(-1)?.ephemeral_message_parameters).toEqual({
      receiver_user_id: MEMBER,
      callback_query_id: expect.stringMatching(/^cb-/),
      replace_callback_query_message: true,
    });
  });

  it("posts the public notice only when configured", async () => {
    const { message, sends } = teamBot({ env: { TELEGRAM_EPHEMERAL_NOTICE: "true" } });
    await message(MEMBER, teamGroup, "/notes@copilot_bot");
    const last = sends().at(-1);
    expect(last?.text).toBe("Sent you the answer privately 👀");
    expect(last?.ephemeral_message_parameters).toBeUndefined();
  });

  it("falls back to the private chat, never the group, when the ephemeral send fails", async () => {
    const { message, sends } = teamBot({ ephemeralFails: true });
    await message(MEMBER, privateChat(MEMBER), "note this: Alex is on extension 6722.");
    await message(MEMBER, teamGroup, "@copilot_bot what did I save about Alex");
    const last = sends().at(-1);
    expect(last?.chat_id).toBe(MEMBER);
    expect(last?.ephemeral_message_parameters).toBeUndefined();
    expect(String(last?.text)).toContain("6722");
    expect(sends().some((payload) => payload.chat_id === TEAM_CHAT && !payload.ephemeral_message_parameters && String(payload.text).includes("6722"))).toBe(false);
  });
});

describe("never ephemeral", () => {
  it("save, reminder and delete confirmations in the group are normal messages", async () => {
    const { message, sends, ephemeralSends } = teamBot();
    await message(MEMBER, teamGroup, "@copilot_bot note this: the core switch is in rack 4.");
    expect(String(sends().at(-1)?.text)).toContain("Saved note");
    await message(MEMBER, teamGroup, "@copilot_bot remind me in 30 minutes to check the UPS");
    expect(String(sends().at(-1)?.text)).toMatch(/remind/i);
    await message(MEMBER, teamGroup, "@copilot_bot delete note 1");
    expect(String(sends().at(-1)?.text)).toContain("Delete note 1");
    await message(MEMBER, teamGroup, "@copilot_bot YES");
    expect(sends().at(-1)?.text).toBe("Deleted note 1.");
    expect(ephemeralSends()).toEqual([]);
  });

  it("reminders are never sent ephemerally", async () => {
    const { message, deps, bot, calls } = teamBot();
    await message(MEMBER, teamGroup, "@copilot_bot remind me in 30 minutes to check the UPS", TOPIC);
    deps.clock = fixedClock("2026-10-30T07:00:00.000Z", "Asia/Dubai");
    const run = await processDueReminders(deps, {
      workerId: "ephemeral-test",
      send: async (chatId, text, _buttons, options) => {
        const sent = await bot.api.sendMessage(chatId, text, options?.threadId ? { message_thread_id: options.threadId } : {});
        return { messageId: sent.message_id };
      },
    });
    expect(run.sent).toBe(1);
    const reminder = calls.filter((call) => call.method === "sendMessage").at(-1)?.payload;
    expect(reminder?.text).toBe("Reminder: check the UPS");
    expect(reminder?.ephemeral_message_parameters).toBeUndefined();
  });

  it("private chats are unchanged", async () => {
    const { message, sends } = teamBot();
    await message(OWNER, privateChat(OWNER), "note this: Alex is on extension 6722.");
    await message(OWNER, privateChat(OWNER), "what did I save about Alex");
    expect(String(sends().at(-1)?.text)).toContain("6722");
    expect(sends().every((payload) => payload.ephemeral_message_parameters === undefined)).toBe(true);
  });
});

describe("message_id 0", () => {
  it("is never kept as a message to edit", async () => {
    const calls: string[] = [];
    const ctx = {
      chat: teamGroup,
      reply: async () => {
        calls.push("sendMessage");
        return { message_id: 0, chat: teamGroup };
      },
      api: {
        editMessageText: async () => {
          calls.push("editMessageText");
          return true;
        },
        deleteMessage: async () => {
          calls.push("deleteMessage");
          return true;
        },
      },
    } as unknown as Context;
    const live = createLiveAnalysis(ctx, { minIntervalMs: 1_000 });
    await live.update("Searching…");
    expect(await live.finish({ text: "Final" })).toBe(false);
    expect(calls).toEqual(["sendMessage"]);
  });
});
