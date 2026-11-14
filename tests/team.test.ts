import type { Bot } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { describe, expect, it } from "vitest";
import { createBot, withoutMention } from "../src/bot/index.js";
import { queuedRepliesSettled } from "../src/bot/draftStream.js";
import { parseEnv } from "../src/config/env.js";
import { processDueReminders } from "../src/jobs/processReminders.js";
import { authorize } from "../src/utils/security.js";
import { fixedClock } from "../src/utils/time.js";
import { testDeps } from "./helpers.js";

const OWNER = 42;
const MEMBER = 77;
const STRANGER = 7;
const TEAM_CHAT = -100555;
const OTHER_GROUP = -100999;
const TOPIC = 12;
const ME = { id: 999, is_bot: true, first_name: "Copilot", username: "copilot_bot" } as UserFromGetMe;

describe("authorize", () => {
  const base = { ownerId: String(OWNER), teamIds: [String(MEMBER)], teamChatId: String(TEAM_CHAT) };
  const cases: Array<[string, { fromId?: number; chatType: string; chatId: number }, true | "unauthorized" | "not_private"]> = [
    ["owner, private chat", { fromId: OWNER, chatType: "private", chatId: OWNER }, true],
    ["team member, private chat", { fromId: MEMBER, chatType: "private", chatId: MEMBER }, true],
    ["stranger, private chat", { fromId: STRANGER, chatType: "private", chatId: STRANGER }, "unauthorized"],
    ["team member, team group", { fromId: MEMBER, chatType: "supergroup", chatId: TEAM_CHAT }, true],
    ["owner, team group", { fromId: OWNER, chatType: "supergroup", chatId: TEAM_CHAT }, true],
    ["stranger, team group", { fromId: STRANGER, chatType: "supergroup", chatId: TEAM_CHAT }, "unauthorized"],
    ["team member, other group", { fromId: MEMBER, chatType: "supergroup", chatId: OTHER_GROUP }, "not_private"],
    ["owner, other basic group", { fromId: OWNER, chatType: "group", chatId: OTHER_GROUP }, "not_private"],
    ["team member, channel with the team id", { fromId: MEMBER, chatType: "channel", chatId: TEAM_CHAT }, "not_private"],
    ["no sender", { chatType: "private", chatId: OWNER }, "unauthorized"],
  ];
  it.each(cases)("%s", (_name, input, expected) => {
    const decision = authorize({ ...base, fromId: undefined, ...input });
    if (expected === true) expect(decision).toEqual({ ok: true });
    else expect(decision).toMatchObject({ ok: false, reason: expected });
  });

  it("keeps the existing refusal messages", () => {
    expect(authorize({ ...base, fromId: STRANGER, chatType: "private", chatId: STRANGER })).toMatchObject({
      message: "This is a private bot. I can't help from this account.",
    });
    expect(authorize({ ...base, fromId: MEMBER, chatType: "group", chatId: OTHER_GROUP })).toMatchObject({
      message: "Please message me in a private chat. I don't share IT records in groups.",
    });
    expect(authorize({ ownerId: "", fromId: OWNER, chatType: "private", chatId: OWNER })).toMatchObject({ reason: "unconfigured" });
  });

  it("refuses every group when no team group is configured", () => {
    expect(authorize({ ownerId: String(OWNER), teamIds: [], teamChatId: "", fromId: OWNER, chatType: "supergroup", chatId: TEAM_CHAT })).toMatchObject({
      reason: "not_private",
    });
  });
});

describe("team env", () => {
  it("parses team ids and the team chat id", () => {
    const env = parseEnv({ TELEGRAM_TEAM_IDS: " 111, 222 ,111,", TELEGRAM_TEAM_CHAT_ID: " -1001234567890 " });
    expect(env.TELEGRAM_TEAM_IDS).toEqual(["111", "222"]);
    expect(env.TELEGRAM_TEAM_CHAT_ID).toBe("-1001234567890");
    expect(parseEnv({}).TELEGRAM_TEAM_IDS).toEqual([]);
  });

  it("rejects malformed values", () => {
    for (const value of ["abc", "111;222", "-111", "111,,222"]) {
      expect(() => parseEnv({ TELEGRAM_TEAM_IDS: value })).toThrow(/TELEGRAM_TEAM_IDS/);
    }
    for (const value of ["1001234567890", "group", "-100x"]) {
      expect(() => parseEnv({ TELEGRAM_TEAM_CHAT_ID: value })).toThrow(/TELEGRAM_TEAM_CHAT_ID/);
    }
  });
});

describe("withoutMention", () => {
  it("removes the bot mention and keeps line breaks", () => {
    expect(withoutMention("@copilot_bot extension for Alex", "copilot_bot")).toBe("extension for Alex");
    expect(withoutMention("@Copilot_Bot, create tasks:\n- check UPS\n- swap toner", "copilot_bot")).toBe("create tasks:\n- check UPS\n- swap toner");
    expect(withoutMention("ask @copilot_bot2 instead", "copilot_bot")).toBe("ask @copilot_bot2 instead");
  });
});

type Call = { method: string; payload: Record<string, unknown> };

function teamBot() {
  const setup = testDeps({ TELEGRAM_TEAM_IDS: String(MEMBER), TELEGRAM_TEAM_CHAT_ID: String(TEAM_CHAT) });
  const warnings: Array<Record<string, unknown>> = [];
  setup.deps.logger = { info() {}, warn(obj) { warnings.push(obj); }, error() {}, debug() {} };
  const bot = createBot(setup.deps.env.TELEGRAM_BOT_TOKEN, setup.deps);
  bot.botInfo = ME as Bot["botInfo"];
  const calls: Call[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    const chat = { id: Number((payload as { chat_id?: number }).chat_id ?? 0), type: "supergroup", title: "Team" };
    return { ok: true, result: method === "sendMessage" ? { message_id: calls.length, date: 0, chat, text: "" } : true } as never;
  });
  let updateId = 0;
  const send = async (from: number, chat: Record<string, unknown>, text: string, topic?: number) => {
    updateId += 1;
    await bot.handleUpdate({
      update_id: updateId,
      message: {
        message_id: updateId,
        date: 0,
        chat,
        from: { id: from, is_bot: false, first_name: `User${from}` },
        text,
        // Telegram marks commands with a bot_command entity; grammY matches on it.
        ...(text.startsWith("/") ? { entities: [{ type: "bot_command", offset: 0, length: text.split(/\s/)[0]?.length ?? 1 }] } : {}),
        ...(topic ? { is_topic_message: true, message_thread_id: topic } : {}),
      },
    } as unknown as Update);
    await queuedRepliesSettled();
  };
  const membership = async (chat: Record<string, unknown>, status: string) => {
    updateId += 1;
    await bot.handleUpdate({
      update_id: updateId,
      my_chat_member: {
        chat,
        from: { id: STRANGER, is_bot: false, first_name: "Someone" },
        date: 0,
        old_chat_member: { status: "left", user: ME },
        new_chat_member: { status, user: ME },
      },
    } as unknown as Update);
  };
  const replies = () => calls.filter((call) => call.method === "sendMessage").map((call) => call.payload);
  /** Group replies may start as a "Searching…" preview that is then edited into the answer. */
  const finalText = () => String(calls.filter((call) => call.method === "sendMessage" || call.method === "editMessageText").at(-1)?.payload.text);
  return { ...setup, bot, calls, warnings, send, membership, replies, finalText };
}

/** upsertFromTelegram never clears startedBot, so with false it is a read of the member's row. */
function memberRow(db: ReturnType<typeof testDeps>["db"]) {
  return db.upsertFromTelegram({ telegramUserId: MEMBER, displayName: `User${MEMBER}`, timezone: "Asia/Dubai", startedBot: false, at: "2026-10-30T06:00:00.000Z" });
}

const teamGroup = { id: TEAM_CHAT, type: "supergroup", title: "IT team", is_forum: true };
const privateChat = (id: number) => ({ id, type: "private", first_name: `User${id}` });

describe("bot membership", () => {
  it("leaves a group that is not the team group", async () => {
    const { membership, calls } = teamBot();
    await membership({ id: OTHER_GROUP, type: "supergroup", title: "Random" }, "member");
    expect(calls).toEqual([{ method: "leaveChat", payload: { chat_id: OTHER_GROUP } }]);
  });

  it("stays in the team group, and warns when removed from it", async () => {
    const { membership, calls, warnings } = teamBot();
    await membership(teamGroup, "administrator");
    expect(calls).toEqual([]);
    await membership(teamGroup, "kicked");
    expect(calls).toEqual([]);
    expect(warnings).toContainEqual(expect.objectContaining({ event: "team_group_removed", status: "kicked" }));
  });
});

describe("team group", () => {
  it("answers a member from their own records only, in the same forum topic", async () => {
    const { send, replies, finalText } = teamBot();
    await send(MEMBER, privateChat(MEMBER), "note this: Alex is on extension 6722.");
    await send(OWNER, teamGroup, "@copilot_bot what did I save about Alex", TOPIC);
    const ownerReply = replies().at(-1);
    expect(ownerReply?.chat_id).toBe(TEAM_CHAT);
    expect(ownerReply?.message_thread_id).toBe(TOPIC);
    expect(finalText()).not.toContain("6722");

    await send(MEMBER, teamGroup, "@copilot_bot what did I save about Alex", TOPIC);
    expect(replies().at(-1)?.message_thread_id).toBe(TOPIC);
    expect(finalText()).toContain("6722");
  });

  it("refuses a stranger in the team group and never answers in another group", async () => {
    const { send, replies } = teamBot();
    await send(STRANGER, teamGroup, "@copilot_bot list my tasks");
    expect(replies().at(-1)?.text).toBe("This is a private bot. I can't help from this account.");
    await send(MEMBER, { id: OTHER_GROUP, type: "supergroup", title: "Random" }, "@copilot_bot list my tasks");
    expect(replies().at(-1)?.text).toBe("Please message me in a private chat. I don't share IT records in groups.");
  });

  it("never posts an admin sign-in link in the group", async () => {
    const { send, replies } = teamBot();
    await send(OWNER, teamGroup, "/admin@copilot_bot");
    expect(String(replies().at(-1)?.text)).toContain("private chat");
    expect(String(replies().at(-1)?.text)).not.toContain("http");
  });

  it("does not treat a group-only member as having started the bot", async () => {
    const { send, db } = teamBot();
    await send(MEMBER, teamGroup, "@copilot_bot list my tasks");
    expect((await memberRow(db)).startedBot).toBe(false);
    await send(MEMBER, privateChat(MEMBER), "/start");
    expect((await memberRow(db)).startedBot).toBe(true);
  });

  it("delivers a reminder made in a topic back to that topic, and a daily summary privately", async () => {
    const { send, deps, db } = teamBot();
    await send(MEMBER, teamGroup, "@copilot_bot remind me in 30 minutes to check the UPS", TOPIC);
    await send(MEMBER, teamGroup, "@copilot_bot give me my daily summary at 8 AM", TOPIC);
    const reminders = await db.listReminders((await memberRow(db)).id);
    const ups = reminders.find((reminder) => reminder.kind === "once");
    const summary = reminders.find((reminder) => reminder.kind === "daily_summary");
    expect(ups).toMatchObject({ deliveryChatId: TEAM_CHAT, deliveryThreadId: TOPIC });
    expect(summary).toMatchObject({ deliveryChatId: null, deliveryThreadId: null });

    const sent: Array<{ chatId: number; threadId?: number }> = [];
    deps.clock = fixedClock("2026-10-30T07:00:00.000Z", "Asia/Dubai");
    const run = await processDueReminders(deps, {
      workerId: "team",
      send: async (chatId, _text, _buttons, options) => {
        sent.push({ chatId, threadId: options?.threadId });
        return { messageId: 1 };
      },
    });
    expect(run.sent).toBe(1);
    expect(sent).toEqual([{ chatId: TEAM_CHAT, threadId: TOPIC }]);
  });
});
