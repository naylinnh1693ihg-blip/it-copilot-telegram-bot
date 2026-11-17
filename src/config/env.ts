import { z } from "zod";

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().default(""),
  TELEGRAM_OWNER_ID: z.string().regex(/^\d*$/).default(""),
  /** Team members' numeric Telegram user ids, comma-separated. Each member gets their own records. */
  TELEGRAM_TEAM_IDS: z
    .string()
    .default("")
    .refine((value) => /^\s*(?:\d+\s*(?:,\s*\d+\s*)*,?\s*)?$/.test(value), {
      message: "use numeric Telegram user ids separated by commas, e.g. 111111111,222222222",
    })
    .transform((value) => [...new Set(value.split(",").map((id) => id.trim()).filter(Boolean))]),
  /** The team supergroup's chat id (negative, e.g. -1001234567890). Every other group is refused and left. */
  TELEGRAM_TEAM_CHAT_ID: z
    .string()
    .default("")
    .transform((value) => value.trim())
    .refine((value) => value === "" || /^-\d+$/.test(value), { message: "use the group's negative chat id, e.g. -1001234567890" }),
  TELEGRAM_WEBHOOK_SECRET: z.string().default(""),
  /** Concurrent HTTPS connections Telegram may open to the webhook. Telegram allows 1-100. One Node process, so keep it low. */
  TELEGRAM_WEBHOOK_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(100).default(10),
  TELEGRAM_MODE: z.enum(["polling", "webhook"]).default("polling"),
  TELEGRAM_API_ROOT: z.string().url().default("https://api.telegram.org"),
  /** Minimum gap between edits of one streaming message. Telegram allows about one edit per second per chat. */
  TELEGRAM_EDIT_INTERVAL_MS: z.coerce.number().int().min(1_000).max(5_000).default(1_100),
  /** Send document summaries and inventory tables as Telegram rich messages. Anything other than "true" keeps plain/MarkdownV2 replies. */
  TELEGRAM_RICH_MESSAGES: z
    .string()
    .default("false")
    .transform((value) => value.trim().toLowerCase() === "true"),
  /** After an ephemeral lookup answer in the team group, also post "Sent you the answer privately 👀" for everyone. */
  TELEGRAM_EPHEMERAL_NOTICE: z
    .string()
    .default("false")
    .transform((value) => value.trim().toLowerCase() === "true"),
  PUBLIC_BASE_URL: z.string().default(""),
  XAI_API_KEY: z.string().default(""),
  XAI_MODEL: z.string().min(1).default("grok-4.7"),
  /** Model used when an image is attached. Empty uses XAI_MODEL. grok-4.7 accepts image input. */
  XAI_VISION_MODEL: z.string().default(""),
  /** vision: send the picture and OCR only if that call fails. ocr: text only. both: OCR for search, picture for analysis. */
  VISION_MODE: z.enum(["vision", "ocr", "both"]).default("both"),
  XAI_EMBEDDING_MODEL: z.string().min(1).default("v1"),
  XAI_EMBEDDING_DIMENSIONS: z.coerce.number().int().min(64).max(2000).default(1024),
  RAG_CHUNK_TOKENS: z.coerce.number().int().min(300).max(800).default(500),
  RAG_CHUNK_OVERLAP_TOKENS: z.coerce.number().int().min(0).max(200).default(80),
  RAG_TOP_K: z.coerce.number().int().min(4).max(8).default(6),
  RAG_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.4),
  RAG_CONTEXT_TOKENS: z.coerce.number().int().min(2000).max(4000).default(3000),
  XAI_MODEL_LONG: z.string().min(1).default("grok-4.20"),
  XAI_MODEL_MAX: z.string().min(1).default("grok-4.20"),
  XAI_ANALYSIS_STANDARD_TOKENS: z.coerce.number().int().positive().default(120_000),
  XAI_ANALYSIS_LONG_TOKENS: z.coerce.number().int().positive().default(400_000),
  /** Stored extraction length. 600_000 characters is about 150_000 tokens, enough to reach the long-context model. */
  DOCUMENT_EXTRACT_MAX_CHARS: z.coerce.number().int().min(10_000).max(800_000).default(600_000),
  XAI_BASE_URL: z.string().url().default("https://api.x.ai/v1"),
  XAI_TIMEOUT_MS: z.coerce.number().int().positive().default(45_000),
  XAI_LONG_CONTEXT_TIMEOUT_MS: z.coerce.number().int().min(45_000).max(120_000).default(90_000),
  XAI_INPUT_USD_PER_MILLION: z.coerce.number().nonnegative().default(2),
  XAI_OUTPUT_USD_PER_MILLION: z.coerce.number().nonnegative().default(6),
  /** Claude backup for when Grok is rate-limited, out of credit, or down. Empty means no fallback. */
  ANTHROPIC_API_KEY: z.string().default(""),
  CLAUDE_MODEL: z.string().min(1).default("claude-opus-5-5"),
  /** Claude streams long answers; this bounds one non-streamed request. */
  CLAUDE_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(600_000).default(120_000),
  /** After a Grok limit or outage, send calls straight to Claude for this long (or Grok's longer retry-after). */
  LLM_FALLBACK_COOLDOWN_MS: z.coerce.number().int().min(0).default(300_000),
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
  /** Serves the admin web app under /admin. Anything other than "true" leaves it off and /admin returns 404. */
  ADMIN_ENABLED: z
    .string()
    .default("false")
    .transform((value) => value.trim().toLowerCase() === "true"),
  /** HMAC key for admin session ids, sign-in tokens, and CSRF tokens. At least 32 characters. */
  ADMIN_SESSION_SECRET: z.string().default(""),
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

/** True only when admin is requested and ADMIN_SESSION_SECRET is long enough. Misconfiguration must not block webhook startup. */
export function adminAppEnabled(env: Env): boolean {
  return env.ADMIN_ENABLED && env.ADMIN_SESSION_SECRET.length >= 32;
}

export const TELEGRAM_CLOUD_DOWNLOAD_LIMIT = 20 * 1024 * 1024;

export function effectiveUploadLimit(env: Env): number {
  const cloud = env.TELEGRAM_API_ROOT.includes("api.telegram.org");
  if (cloud) return Math.min(env.MAX_UPLOAD_BYTES, TELEGRAM_CLOUD_DOWNLOAD_LIMIT);
  return env.MAX_UPLOAD_BYTES;
}
