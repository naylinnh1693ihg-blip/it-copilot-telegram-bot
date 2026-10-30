import { z } from "zod";

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().default(""),
  TELEGRAM_OWNER_ID: z.string().regex(/^\d*$/).default(""),
  TELEGRAM_WEBHOOK_SECRET: z.string().default(""),
  TELEGRAM_MODE: z.enum(["polling", "webhook"]).default("polling"),
  TELEGRAM_API_ROOT: z.string().url().default("https://api.telegram.org"),
  PUBLIC_BASE_URL: z.string().default(""),
  XAI_API_KEY: z.string().default(""),
  XAI_MODEL: z.string().min(1).default("grok-4.7"),
  XAI_BASE_URL: z.string().url().default("https://api.x.ai/v1"),
  XAI_TIMEOUT_MS: z.coerce.number().int().positive().default(45_000),
  XAI_INPUT_USD_PER_MILLION: z.coerce.number().nonnegative().default(2),
  XAI_OUTPUT_USD_PER_MILLION: z.coerce.number().nonnegative().default(6),
  SUPABASE_URL: z.string().default(""),
  SUPABASE_ANON_KEY: z.string().default(""),
  SUPABASE_SERVICE_ROLE_KEY: z.string().default(""),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_TIMEZONE: z.string().min(1).default("Asia/Dubai"),
  CRON_SECRET: z.string().default(""),
  REMINDER_POLL_MS: z.coerce.number().int().nonnegative().default(30_000),
  LOG_LEVEL: z.string().default("info"),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(20 * 1024 * 1024),
});

export type Env = z.infer<typeof schema>;

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = schema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid environment: ${details}`);
  }
  return result.data;
}

export function missingRuntimeSettings(env: Env): string[] {
  const missing: string[] = [];
  if (!env.TELEGRAM_BOT_TOKEN) missing.push("TELEGRAM_BOT_TOKEN");
  if (!env.SUPABASE_URL) missing.push("SUPABASE_URL");
  if (!env.SUPABASE_SERVICE_ROLE_KEY) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (env.TELEGRAM_MODE === "webhook") {
    if (!env.TELEGRAM_WEBHOOK_SECRET) missing.push("TELEGRAM_WEBHOOK_SECRET");
    if (!env.PUBLIC_BASE_URL) missing.push("PUBLIC_BASE_URL");
    if (env.TELEGRAM_WEBHOOK_SECRET && !/^[A-Za-z0-9_-]{1,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET)) {
      missing.push("TELEGRAM_WEBHOOK_SECRET (use 1-256 characters: letters, numbers, _ or -)");
    }
  }
  return missing;
}

export const TELEGRAM_CLOUD_DOWNLOAD_LIMIT = 20 * 1024 * 1024;

export function effectiveUploadLimit(env: Env): number {
  const cloud = env.TELEGRAM_API_ROOT.includes("api.telegram.org");
  if (cloud) return Math.min(env.MAX_UPLOAD_BYTES, TELEGRAM_CLOUD_DOWNLOAD_LIMIT);
  return env.MAX_UPLOAD_BYTES;
}
