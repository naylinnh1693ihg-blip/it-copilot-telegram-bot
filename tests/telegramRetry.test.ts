import { Api, Context, type Transformer } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { describe, expect, it } from "vitest";
import { createBot } from "../src/bot/index.js";
import { createLiveAnalysis } from "../src/bot/handlers/messages.js";
import { telegramRetry } from "../src/bot/telegramRetry.js";
import { processDueReminders } from "../src/jobs/processReminders.js";
import { NOW, owner, testDeps } from "./helpers.js";

type Answer = { ok: true; result: unknown } | { ok: false; error_code: number; description: string; parameters?: { retry_after?: number } };

const tooMany = (seconds: number): Answer => ({
  ok: false,
  error_code: 429,
  description: `Too Many Requests: retry after ${seconds}`,
  parameters: { retry_after: seconds },
});

const sentMessage = (id: number, text = "ok") => ({ message_id: id, date: 0, chat: { id: 42, type: "private", first_name: "Owner" }, text });

/**
 * An Api whose network layer is a script of answers per method. The retry transformer is
 * installed after it, so it wraps the fake exactly as it wraps real HTTP in production.
 */
function scriptedApi(script: Record<string, Answer[]>) {
  const calls: string[] = [];
  const api = new Api("123456:test-token-value");
  const network: Transformer = async (_prev, method) => {
    calls.push(method);
    const answer = script[method]?.shift() ?? { ok: true, result: method === "sendMessage" ? sentMessage(calls.length) : true };
    return answer as never;
  };
  api.config.use(network);
  api.config.use(telegramRetry());
  return { api, calls };
}

describe("telegram auto-retry", () => {
  it("is installed on every bot", () => {
    const { deps } = testDeps();
    const bot = createBot(deps.env.TELEGRAM_BOT_TOKEN, deps);
    expect(bot.api.config.installedTransformers()).toHaveLength(1);
  });

  it("waits out a short 429 and sends the message once", async () => {
    const { api, calls } = scriptedApi({ sendMessage: [tooMany(1), { ok: true, result: sentMessage(7) }] });
    const started = Date.now();
    const sent = await api.sendMessage(42, "hello");
    expect(sent.message_id).toBe(7);
    expect(calls).toEqual(["sendMessage", "sendMessage"]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it("rethrows a 429 longer than maxDelaySeconds without waiting", async () => {
    const { api, calls } = scriptedApi({ sendMessage: [tooMany(30)] });
    const started = Date.now();
    await expect(api.sendMessage(42, "hello")).rejects.toMatchObject({ error_code: 429, parameters: { retry_after: 30 } });
    expect(calls).toEqual(["sendMessage"]);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("records a long 429 as a failed reminder attempt, not a send", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    const { reminder } = await db.insertReminder({
      userId: user.id,
      title: "Backup",
      message: "Check the server backup",
      kind: "once",
      timezone: "Asia/Dubai",
      nextRunAt: "2026-10-30T06:00:00.000Z",
      weekdays: [],
      intervalMinutes: null,
      status: "active",
      dedupeKey: "once|backup|429|",
      createdAt: NOW,
    });
    const { api } = scriptedApi({ sendMessage: [tooMany(30)] });
    const run = await processDueReminders(deps, {
      workerId: "retry-test",
      send: async (telegramUserId, text) => ({ messageId: (await api.sendMessage(telegramUserId, text)).message_id }),
    });
    expect(run).toEqual({ sent: 0, failed: 1, skipped: 0 });
    const saved = await db.findReminderById(reminder.id);
    expect(saved?.status).toBe("active");
    expect(saved?.attemptOccurrenceAt).toBe("2026-10-30T06:00:00.000Z");
    expect(saved?.lastError).toContain("429");
    expect(saved?.nextRunAt).not.toBe("2026-10-30T06:00:00.000Z");
  });
});

describe("streaming previews", () => {
  function liveContext(script: Record<string, Answer[]>) {
    const { api, calls } = scriptedApi(script);
    const update = { update_id: 1, message: { ...sentMessage(1, "question"), from: { id: 42, is_bot: false, first_name: "Owner" } } } as unknown as Update;
    const me = { id: 999, is_bot: true, first_name: "Copilot", username: "copilot_bot" } as UserFromGetMe;
    return { ctx: new Context(update, api, me), calls };
  }

  it("does not let auto-retry wait on a rate-limited preview edit, and flush still delivers the answer", async () => {
    const { ctx, calls } = liveContext({ editMessageText: [tooMany(3)] });
    const live = createLiveAnalysis(ctx, { minIntervalMs: 1_000 });
    await live.update("Working…");

    const started = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    await live.update("Working… step 2");
    const editTook = Date.now() - started;
    expect(calls).toEqual(["sendMessage", "editMessageText"]);
    expect(editTook).toBeLessThan(1_500);

    // The throttled editor waits the 3 s retry_after once, then edits the final text.
    expect(await live.finish({ text: "Final answer" })).toBe(true);
    expect(calls).toEqual(["sendMessage", "editMessageText", "editMessageText"]);
  }, 10_000);
});
