import "dotenv/config";
import { adminAppEnabled, missingRuntimeSettings, parseEnv } from "./config/env.js";
import { createSupabaseClient, SupabaseDatabase } from "./database/supabase.js";
import { createSupabaseStorage } from "./services/documents/storage.js";
import { createXaiClient } from "./services/grok/xai.js";
import { ALLOWED_UPDATES, createBot, telegramWebhook } from "./bot/index.js";
import { ensureWebhook } from "./bot/webhookGuard.js";
import { inlineButtons } from "./bot/keyboards/menus.js";
import { syncBotProfile } from "./bot/profile.js";
import { createHttpApp } from "./routes/http.js";
import { processDueReminders } from "./jobs/processReminders.js";
import { createLogger } from "./utils/logger.js";
import { assertZone, zoneClock } from "./utils/time.js";
import type { Deps } from "./app/deps.js";

async function main(): Promise<void> {
  const env = parseEnv(process.env);
  assertZone(env.APP_TIMEZONE);
  const missing = missingRuntimeSettings(env);
  if (missing.length > 0) {
    console.error(`Missing required settings: ${missing.join(", ")}`);
    console.error("Copy .env.example to .env and fill in the values. No secrets belong in source code.");
    process.exit(1);
  }

  const logger = createLogger(env.LOG_LEVEL);
  if (env.ADMIN_ENABLED && !adminAppEnabled(env)) {
    logger.warn(
      { event: "admin_disabled" },
      "ADMIN_ENABLED is true but ADMIN_SESSION_SECRET is missing or shorter than 32 characters. The admin app stays off until you set a long secret.",
    );
  }
  const client = createSupabaseClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const db = new SupabaseDatabase(client);
  const ping = await db.ping();
  if (!ping.ok) {
    logger.error({ event: "database_unavailable", reason: ping.reason }, "database ping failed");
    process.exit(1);
  }

  const deps: Deps = {
    env,
    db,
    clock: zoneClock(env.APP_TIMEZONE),
    logger,
    llm: env.XAI_API_KEY
      ? createXaiClient({
          apiKey: env.XAI_API_KEY,
          baseUrl: env.XAI_BASE_URL,
          model: env.XAI_MODEL,
          timeoutMs: env.XAI_TIMEOUT_MS,
        })
      : null,
    storage: createSupabaseStorage(client),
  };

  if (!env.TELEGRAM_OWNER_ID) {
    logger.warn({ event: "owner_missing" }, "TELEGRAM_OWNER_ID is empty. The bot will not reveal or store information.");
  }

  const bot = createBot(env.TELEGRAM_BOT_TOKEN, deps);
  // Command menu and descriptions come from code. Not awaited: it is cosmetic, logs its own
  // failures, and must not delay or stop startup in webhook or polling mode.
  void syncBotProfile(bot.api, logger);
  const sendReminder = async (
    chatId: number,
    text: string,
    buttons?: Array<{ label: string; data: string }>,
    options?: { threadId?: number },
  ) => {
    const sent = await bot.api.sendMessage(chatId, text, {
      ...(buttons?.length ? { reply_markup: inlineButtons(buttons) } : {}),
      ...(options?.threadId ? { message_thread_id: options.threadId } : {}),
    });
    return { messageId: sent.message_id };
  };
  const app = createHttpApp(deps, {
    sendTelegram: sendReminder,
    webhook: env.TELEGRAM_MODE === "webhook" ? telegramWebhook(bot, env.TELEGRAM_WEBHOOK_SECRET) : undefined,
  });

  const server = app.listen(env.PORT, () => {
    logger.info({ event: "listening", port: env.PORT, mode: env.TELEGRAM_MODE }, "http server listening");
  });

  if (env.TELEGRAM_MODE === "webhook") {
    const state = await ensureWebhook(bot.api, env, logger);
    if (state === "ok") logger.info({ event: "webhook_set" }, "telegram webhook already registered");
    const timer = setInterval(() => {
      void ensureWebhook(bot.api, env, logger).catch((error: unknown) => {
        logger.error(
          { event: "webhook_restore_failed", message: error instanceof Error ? error.message : "error" },
          "could not check the telegram webhook",
        );
      });
    }, 60_000);
    timer.unref?.();
  } else {
    void bot.start({
      allowed_updates: ALLOWED_UPDATES,
      onStart: () => logger.info({ event: "polling" }, "telegram long polling started"),
    });
  }

  if (env.REMINDER_POLL_MS > 0) {
    const timer = setInterval(() => {
      void processDueReminders(deps, {
        workerId: `poll-${process.pid}`,
        source: "poll",
        send: sendReminder,
      }).catch((error: unknown) => {
        logger.error({ event: "reminder_poll_failed", message: error instanceof Error ? error.message : "error" }, "reminder poll failed");
      });
    }, env.REMINDER_POLL_MS);
    timer.unref?.();
  }

  const shutdown = () => {
    void bot.stop();
    server.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Startup failed");
  process.exit(1);
});
