import { z } from "zod";
import { CLAUDE_TASKS, type ClaudeTask } from "../services/llm/tasks.js";

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().default(""),
  TELEGRAM_OWNER_ID: z.string().regex(/^\d*$/).default(""),
  TELEGRAM_WEBHOOK_SECRET: z.string().default(""),
  TELEGRAM_MODE: z.enum(["polling", "webhook"]).default("polling"),
  TELEGRAM_API_ROOT: z.string().url().default("https://api.telegram.org"),
  /** Minimum gap between edits of one streaming message. Telegram allows about one edit per second per chat. */
  TELEGRAM_EDIT_INTERVAL_MS: z.coerce.number().int().min(1_000).max(5_000).default(1_100),
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
  /** Optional second provider. Empty leaves the bot on xAI only. */
  ANTHROPIC_API_KEY: z.string().default(""),
  ANTHROPIC_BASE_URL: z.string().url().default("https://api.anthropic.com"),
  /** Used for answers and document analysis. */
  ANTHROPIC_MODEL: z.string().min(1).default("claude-sonnet-5-5"),
  /** Used for short structured extraction. */
  ANTHROPIC_MODEL_FAST: z.string().min(1).default("claude-haiku-5-5"),
  ANTHROPIC_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  ANTHROPIC_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(64_000).default(8_192),
  /** Requests estimated above this many input tokens (characters / 4) stay on xAI. */
  ANTHROPIC_MAX_INPUT_TOKENS: z.coerce.number().int().positive().default(500_000),
  /** Comma list from extract, answer, document. Empty sends nothing to Claude. */
  LLM_CLAUDE_TASKS: z
    .string()
    .default("")
    .transform((value, ctx): ClaudeTask[] => {
      const items = value
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);
      const unknown = items.filter((item) => !(CLAUDE_TASKS as readonly string[]).includes(item));
      if (unknown.length > 0) {
        ctx.addIssue({ code: "custom", message: `unknown task ${unknown.join(", ")}. Use ${CLAUDE_TASKS.join(", ")}` });
        return z.NEVER;
      }
      return [...new Set(items)] as ClaudeTask[];
    }),
  /** When "true", a failed call on a task Claude can handle is retried once on the other provider. */
  LLM_FALLBACK: z
    .string()
    .default("false")
    .transform((value) => value.trim().toLowerCase() === "true"),
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
  if (!env.ANTHROPIC_API_KEY && (env.LLM_CLAUDE_TASKS.length > 0 || env.LLM_FALLBACK)) {
    missing.push("ANTHROPIC_API_KEY (needed when LLM_CLAUDE_TASKS or LLM_FALLBACK is set)");
  }
  if (env.ADMIN_ENABLED && env.ADMIN_SESSION_SECRET.length < 32) {
    missing.push("ADMIN_SESSION_SECRET (at least 32 characters when ADMIN_ENABLED=true)");
  }
  return missing;
}

export const TELEGRAM_CLOUD_DOWNLOAD_LIMIT = 20 * 1024 * 1024;

export function effectiveUploadLimit(env: Env): number {
  const cloud = env.TELEGRAM_API_ROOT.includes("api.telegram.org");
  if (cloud) return Math.min(env.MAX_UPLOAD_BYTES, TELEGRAM_CLOUD_DOWNLOAD_LIMIT);
  return env.MAX_UPLOAD_BYTES;
}
