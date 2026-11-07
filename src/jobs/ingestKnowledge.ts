import "dotenv/config";
import { parseEnv } from "../config/env.js";
import { createSupabaseClient, SupabaseDatabase } from "../database/supabase.js";
import { createXaiClient } from "../services/grok/xai.js";
import { ingestKnowledge } from "../services/rag/ingest.js";
import { MemoryStorage } from "../services/documents/storage.js";
import { createLogger } from "../utils/logger.js";
import { assertZone, zoneClock } from "../utils/time.js";

async function main(): Promise<void> {
  const env = parseEnv(process.env);
  assertZone(env.APP_TIMEZONE);
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required. Nothing was changed.");
    process.exit(1);
  }

  const logger = createLogger(env.LOG_LEVEL);
  const client = createSupabaseClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const db = new SupabaseDatabase(client);
  const ping = await db.ping();
  if (!ping.ok) {
    console.error("Database ping failed. Nothing was ingested.");
    process.exit(1);
  }

  const counts = await ingestKnowledge({
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
    storage: new MemoryStorage(),
  });
  console.log(
    `Ingest finished. processed=${counts.processed} skipped=${counts.skipped} failed=${counts.failed} narrative=${counts.narrative} identifier=${counts.identifier}`,
  );
  if (counts.failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Ingest failed.");
  process.exit(1);
});
