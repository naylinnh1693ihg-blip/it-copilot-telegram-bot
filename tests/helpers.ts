import type { Deps } from "../src/app/deps.js";
import { parseEnv } from "../src/config/env.js";
import { createMemoryDatabase } from "../src/database/memory.js";
import type { Database } from "../src/database/types.js";
import { MemoryStorage } from "../src/services/documents/storage.js";
import type { User } from "../src/types/models.js";
import { silentLogger } from "../src/utils/logger.js";
import { fixedClock } from "../src/utils/time.js";

export const NOW = "2026-10-30T10:00:00.000+04:00";
export const ZONE = "Asia/Dubai";

export function testDeps(envOverrides: Record<string, string> = {}): {
  deps: Deps;
  db: Database;
  storage: MemoryStorage;
} {
  const db = createMemoryDatabase();
  const storage = new MemoryStorage();
  const deps: Deps = {
    env: parseEnv({
      TELEGRAM_BOT_TOKEN: "123456:test-token-value",
      TELEGRAM_OWNER_ID: "42",
      TELEGRAM_WEBHOOK_SECRET: "hook_secret",
      XAI_API_KEY: "xai-test-secret-value",
      XAI_MODEL: "grok-4.7",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-test-value",
      CRON_SECRET: "cron_secret_value",
      APP_TIMEZONE: ZONE,
      NODE_ENV: "test",
      REMINDER_POLL_MS: "0",
      ...envOverrides,
    }),
    db,
    clock: fixedClock(NOW, ZONE),
    logger: silentLogger,
    llm: null,
    storage,
  };
  return { deps, db, storage };
}

export async function owner(db: Database): Promise<User> {
  return db.upsertFromTelegram({
    telegramUserId: 42,
    displayName: "Nay",
    timezone: ZONE,
    startedBot: true,
    at: NOW,
  });
}
