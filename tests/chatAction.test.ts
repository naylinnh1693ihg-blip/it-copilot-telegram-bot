import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_ACTION_REFRESH_MS, keepChatAction } from "../src/bot/handlers/messages.js";

function fakeCtx(options: { chat?: boolean; fail?: boolean } = {}) {
  const actions: string[] = [];
  const ctx = {
    chat: options.chat === false ? undefined : { id: 42, type: "private" as const, first_name: "Owner" },
    replyWithChatAction: async (action: string) => {
      actions.push(action);
      if (options.fail) throw new Error("Too Many Requests");
      return true as const;
    },
  };
  return { ctx: ctx as unknown as Parameters<typeof keepChatAction>[0], actions };
}

describe("keepChatAction", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends typing immediately and refreshes it every 4 seconds until stopped", () => {
    const { ctx, actions } = fakeCtx();
    const typing = keepChatAction(ctx);
    expect(actions).toEqual(["typing"]);

    vi.advanceTimersByTime(CHAT_ACTION_REFRESH_MS - 1);
    expect(actions).toEqual(["typing"]);
    vi.advanceTimersByTime(1);
    expect(actions).toEqual(["typing", "typing"]);
    vi.advanceTimersByTime(CHAT_ACTION_REFRESH_MS);
    expect(actions).toHaveLength(3);

    typing.stop();
    vi.advanceTimersByTime(CHAT_ACTION_REFRESH_MS * 5);
    expect(actions).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the requested upload action", () => {
    for (const action of ["upload_document", "upload_photo"] as const) {
      const { ctx, actions } = fakeCtx();
      const uploading = keepChatAction(ctx, action);
      vi.advanceTimersByTime(CHAT_ACTION_REFRESH_MS);
      uploading.stop();
      expect(actions).toEqual([action, action]);
    }
  });

  it("refreshes at 4 seconds, inside Telegram's roughly 5-second display window", () => {
    expect(CHAT_ACTION_REFRESH_MS).toBe(4_000);
  });

  it("sends nothing when the update has no chat", () => {
    const { ctx, actions } = fakeCtx({ chat: false });
    const typing = keepChatAction(ctx);
    vi.advanceTimersByTime(CHAT_ACTION_REFRESH_MS * 2);
    typing.stop();
    expect(actions).toEqual([]);
  });

  it("keeps going when Telegram rejects an action", async () => {
    const { ctx, actions } = fakeCtx({ fail: true });
    const typing = keepChatAction(ctx, "upload_document");
    await vi.advanceTimersByTimeAsync(CHAT_ACTION_REFRESH_MS);
    typing.stop();
    expect(actions).toEqual(["upload_document", "upload_document"]);
  });
});
