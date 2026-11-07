import "dotenv/config";
import { parseEnv } from "../config/env.js";
import { createSupabaseClient, SupabaseDatabase } from "../database/supabase.js";
import { backfillNoteLinks } from "../services/notes/links.js";
import { createLogger } from "../utils/logger.js";

async function main(): Promise<void> {
  const env = parseEnv(process.env);
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required. Nothing was changed.");
    process.exit(1);
  }
  const logger = createLogger(env.LOG_LEVEL);
  const db = new SupabaseDatabase(createSupabaseClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY));
  const ping = await db.ping();
  if (!ping.ok) {
    console.error("Database ping failed. Nothing was linked.");
    process.exit(1);
  }
  const counts = await backfillNoteLinks({ db, logger });
  console.log(`Note links finished. tasks=${counts.tasks} documents=${counts.documents} failed=${counts.failed}`);
  process.exit(counts.failed > 0 ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Note link backfill failed");
  process.exit(1);
});
