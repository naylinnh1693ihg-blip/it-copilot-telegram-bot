import { describe, expect, it } from "vitest";
import { ensureWebhook, webhookEndpoint } from "../src/bot/webhookGuard.js";
import { silentLogger } from "../src/utils/logger.js";

const env = {
  PUBLIC_BASE_URL: "https://it-work-copilot.onrender.com/",
  TELEGRAM_WEBHOOK_SECRET: "hook_secret",
  TELEGRAM_WEBHOOK_MAX_CONNECTIONS: 10,
};

describe("ensureWebhook", () => {
  it("registers the webhook when Telegram has none", async () => {
    const calls: string[] = [];
    const state = await ensureWebhook(
      {
        async getWebhookInfo() {
          calls.push("get");
          return { url: "" };
        },
        async setWebhook(url) {
          calls.push(url);
        },
      },
      env,
      silentLogger,
    );
    expect(state).toBe("restored");
    expect(calls).toEqual(["get", "https://it-work-copilot.onrender.com/telegram/webhook"]);
  });

  it("leaves a matching webhook alone", async () => {
    const state = await ensureWebhook(
      {
        async getWebhookInfo() {
          return { url: webhookEndpoint(env.PUBLIC_BASE_URL) };
        },
        async setWebhook() {
          throw new Error("should not set");
        },
      },
      env,
      silentLogger,
    );
    expect(state).toBe("ok");
  });
});
