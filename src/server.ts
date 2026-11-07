import "dotenv/config";
import { missingRuntimeSettings, parseEnv } from "./config/env.js";
import { createSupabaseClient, SupabaseDatabase } from "./database/supabase.js";
import { createSupabaseStorage } from "./services/documents/storage.js";
import { createXaiClient } from "./services/grok/xai.js";
import { createBot, telegramWebhook } from "./bot/index.js";
import { inlineButtons } from "./bot/keyboards/menus.js";
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
  const sendReminder = async (telegramUserId: number, text: string, buttons?: Array<{ label: string; data: string }>) => {
    const sent = await bot.api.sendMessage(
      telegramUserId,
      text,
      buttons?.length ? { reply_markup: inlineButtons(buttons) } : undefined,
    );
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
    const endpoint = `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/telegram/webhook`;
    await bot.api.setWebhook(endpoint, { secret_token: env.TELEGRAM_WEBHOOK_SECRET });
    logger.info({ event: "webhook_set", endpoint }, "telegram webhook registered");
  } else {
    void bot.start({
      onStart: () => logger.info({ event: "polling" }, "telegram long polling started"),
    });
  }

  if (env.REMINDER_POLL_MS > 0) {
    const timer = setInterval(() => {
      void processDueReminders(deps, {
        workerId: `poll-${process.pid}`,
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
