import { Context, type Bot } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDraftStream,
  DRAFT_REFRESH_MS,
  queuedRepliesSettled,
  randomDraftId,
  registerGeneration,
} from "../src/bot/draftStream.js";
import { createBot, deliver } from "../src/bot/index.js";
import { currentAbortSignal, withAbortSignal } from "../src/services/grok/abort.js";
import { createResilientClient, type LlmClient } from "../src/services/grok/client.js";
import { handleText } from "../src/services/assistant/handleText.js";
import { GenerationStoppedError } from "../src/utils/errors.js";
import { owner, testDeps } from "./helpers.js";

const OWNER = 42;
const ME = { id: 999, is_bot: true, first_name: "Copilot", username: "copilot_bot" } as UserFromGetMe;
const privateChat = (id = OWNER) => ({ id, type: "private" as const, first_name: "Owner" });

type Call = { method: string; payload: Record<string, unknown> };

/** A context whose API records calls instead of reaching Telegram. */
function recordingContext(chat: Record<string, unknown> = privateChat(), options: { failSend?: boolean } = {}) {
  const calls: Call[] = [];
  const api = {
    sendMessageDraft: async (chat_id: number, draft_id: number, text: string, other?: Record<string, unknown>) => {
      calls.push({ method: "sendMessageDraft", payload: { chat_id, draft_id, text, ...other } });
      return true;
    },
  };
  const ctx = {
    chat,
    api,
    reply: async (text: string, other?: Record<string, unknown>) => {
      calls.push({ method: "sendMessage", payload: { text, ...other } });
      if (options.failSend) throw new Error("Bad Request: can't parse entities");
      return { message_id: calls.length, chat };
    },
  } as unknown as Context;
  return { ctx, calls };
}

const drafts = (calls: Call[]) => calls.filter((call) => call.method === "sendMessageDraft").map((call) => call.payload);

describe("createDraftStream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens with the empty Thinking… placeholder, then streams text on one draft id, throttled", async () => {
    const { ctx, calls } = recordingContext();
    const draft = createDraftStream(ctx, OWNER, { minIntervalMs: 1_100 });
    await draft.update("Working…");
    expect(drafts(calls)).toEqual([{ chat_id: OWNER, draft_id: draft.draftId, text: "", can_stop: true, keep_on_stop: true }]);

    await draft.update("Key notes: VLAN 20");
    await draft.update("Key notes: VLAN 20 is guest");
    expect(drafts(calls).map((payload) => payload.text)).toEqual(["", "Key notes: VLAN 20"]);

    vi.advanceTimersByTime(1_100);
    await draft.update("Key notes: VLAN 20 is guest Wi-Fi");
    expect(drafts(calls).map((payload) => payload.text)).toEqual(["", "Key notes: VLAN 20", "Key notes: VLAN 20 is guest Wi-Fi"]);
    expect(new Set(drafts(calls).map((payload) => payload.draft_id))).toEqual(new Set([draft.draftId]));
    expect(draft.partial()).toBe("Key notes: VLAN 20 is guest Wi-Fi");
    draft.close();
  });

  it("never treats a status preview as answer text", async () => {
    const { ctx, calls } = recordingContext();
    const draft = createDraftStream(ctx, OWNER, { minIntervalMs: 1_000 });
    await draft.update("Searching…");
    await draft.update("Analyzing the document…");
    expect(drafts(calls).map((payload) => payload.text)).toEqual([""]);
    expect(draft.partial()).toBe("");
    draft.close();
  });

  it("refreshes the draft during a gap longer than 20 seconds", async () => {
    const { ctx, calls } = recordingContext();
    const draft = createDraftStream(ctx, OWNER, { minIntervalMs: 1_000 });
    await draft.update("Working…");
    await draft.update("Partial answer");
    expect(drafts(calls)).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(DRAFT_REFRESH_MS - 5_000);
    expect(drafts(calls)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(drafts(calls).map((payload) => payload.text)).toEqual(["", "Partial answer", "Partial answer"]);

    draft.close();
    await vi.advanceTimersByTimeAsync(DRAFT_REFRESH_MS * 3);
    expect(drafts(calls)).toHaveLength(3);
  });

  it("finish() sends the full text once and returns true", async () => {
    const { ctx, calls } = recordingContext();
    const draft = createDraftStream(ctx, OWNER, { minIntervalMs: 1_000 });
    await draft.update("Working…");
    expect(await draft.finish({ text: "The full answer.", keyboard: "menu" })).toBe(true);
    const sent = calls.filter((call) => call.method === "sendMessage");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload.text).toBe("The full answer.");
    expect(sent[0]?.payload.reply_markup).toBeDefined();
  });

  it("finish() returns false when sendMessage throws", async () => {
    const { ctx } = recordingContext(privateChat(), { failSend: true });
    const draft = createDraftStream(ctx, OWNER, { minIntervalMs: 1_000 });
    expect(await draft.finish({ text: "The full answer." })).toBe(false);
  });

  it("uses a non-zero 31-bit draft id", () => {
    for (let index = 0; index < 200; index += 1) {
      const id = randomDraftId();
      expect(id).toBeGreaterThan(0);
      expect(id).toBeLessThan(2 ** 31);
    }
  });
});

/** A bot whose API records every call. Installed after createBot, so it answers before auto-retry. */
function offlineBot() {
  const setup = testDeps();
  const bot = createBot(setup.deps.env.TELEGRAM_BOT_TOKEN, setup.deps);
  bot.botInfo = ME as Bot["botInfo"];
  const calls: Call[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    const result = method === "sendMessage" ? { message_id: calls.length, date: 0, chat: privateChat(), text: "" } : true;
    return { ok: true, result } as never;
  });
  return { ...setup, bot, calls };
}

const stopUpdate = (updateId: number, chatId: number, draftId: number): Update =>
  ({ update_id: updateId, stopped_message_generation: { chat: privateChat(chatId), draft_id: draftId } }) as unknown as Update;

/** An LLM fake that streams nothing and waits until its signal is aborted. */
function waitingLlm(seen: { signal?: AbortSignal }): LlmClient {
  return {
    async completeStructured() {
      throw new Error("classification should not run");
    },
    async completeText() {
      throw new Error("completeText should not run");
    },
    async streamText(input) {
      seen.signal = input.signal;
      await new Promise<void>((resolve) => input.signal?.addEventListener("abort", () => resolve()));
      throw new GenerationStoppedError();
    },
  };
}

describe("Stop button", () => {
  it("aborts the signal passed to Grok and replies Stopped. when nothing was streamed", async () => {
    const { bot, deps, db, calls } = offlineBot();
    const user = await owner(db);
    await handleText(deps, user, "note this: The floor 2 printer is near reception.");
    const seen: { signal?: AbortSignal } = {};
    deps.llm = waitingLlm(seen);

    await bot.handleUpdate({
      update_id: 1,
      message: { message_id: 1, date: 0, chat: privateChat(), from: { id: OWNER, is_bot: false, first_name: "Owner" }, text: "Where is the floor 2 printer?" },
    } as unknown as Update);
    await vi.waitFor(() => expect(seen.signal).toBeDefined());
    const draft = drafts(calls)[0];
    expect(draft?.text).toBe("");
    expect(draft?.can_stop).toBe(true);
    expect(calls.some((call) => call.method === "sendChatAction")).toBe(false);

    await bot.handleUpdate(stopUpdate(2, OWNER, Number(draft?.draft_id)));
    await queuedRepliesSettled();
    expect(seen.signal?.aborted).toBe(true);
    expect(calls.filter((call) => call.method === "sendMessage").map((call) => call.payload.text)).toEqual(["Stopped."]);
  });

  it("sends the partial answer marked (Stopped.)", async () => {
    const { bot, deps, calls } = offlineBot();
    const ctx = new Context({ update_id: 3, message: { message_id: 1, date: 0, chat: privateChat(), text: "summarize" } } as unknown as Update, bot.api, ME);
    let signal: AbortSignal | undefined;
    await deliver(deps, ctx, async (preview) => {
      signal = currentAbortSignal();
      await preview("Analyzing the document…");
      await preview("Key notes:\n• Core switch is 10.0.0.2");
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve()));
      throw new GenerationStoppedError();
    });
    await vi.waitFor(() => expect(drafts(calls)).toHaveLength(2));

    await bot.handleUpdate(stopUpdate(4, OWNER, Number(drafts(calls)[0]?.draft_id)));
    await queuedRepliesSettled();
    expect(signal?.aborted).toBe(true);
    expect(calls.filter((call) => call.method === "sendMessage").map((call) => call.payload.text)).toEqual([
      "Key notes:\n• Core switch is 10.0.0.2\n\n(Stopped.)",
    ]);
  });

  it("ignores a Stop update from a chat that is not the owner's, without replying", async () => {
    const { bot, calls } = offlineBot();
    const generation = registerGeneration(7, 1234);
    await bot.handleUpdate(stopUpdate(5, 7, 1234));
    expect(generation.signal.aborted).toBe(false);
    expect(calls).toEqual([]);
    generation.release();
  });
});

describe("group chats", () => {
  it("keep the edit-based preview instead of drafts", async () => {
    const { bot, deps, calls } = offlineBot();
    const group = { id: -100123, type: "group" as const, title: "Team" };
    const ctx = new Context({ update_id: 6, message: { message_id: 1, date: 0, chat: group, text: "hi" } } as unknown as Update, bot.api, ME);
    await deliver(deps, ctx, async (preview) => {
      await preview("Working…");
      return { text: "Done." };
    });
    const methods = calls.map((call) => call.method);
    expect(methods).not.toContain("sendMessageDraft");
    expect(methods).toContain("sendMessage");
    expect(methods).toContain("editMessageText");
    expect(calls.find((call) => call.method === "sendMessage")?.payload.text).toBe("Working…");
  });
});

describe("Grok client and Stop", () => {
  it("passes the ambient signal to the SDK and reports an abort as stopped, without retrying", async () => {
    const controller = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    const llm = createResilientClient({
      model: "grok-test",
      sleep: async () => undefined,
      create: async (_body, options) => {
        seen.push(options?.signal);
        controller.abort();
        throw Object.assign(new Error("Request was aborted."), { name: "APIUserAbortError" });
      },
    });
    await expect(withAbortSignal(controller.signal, () => llm.completeText({ system: "s", user: "u" }))).rejects.toBeInstanceOf(GenerationStoppedError);
    expect(seen).toEqual([controller.signal]);
  });

  it("does not call Grok at all once stopped", async () => {
    const controller = new AbortController();
    controller.abort();
    const create = vi.fn();
    const llm = createResilientClient({ model: "grok-test", create });
    await expect(llm.completeText({ system: "s", user: "u", signal: controller.signal })).rejects.toBeInstanceOf(GenerationStoppedError);
    expect(create).not.toHaveBeenCalled();
  });
});
