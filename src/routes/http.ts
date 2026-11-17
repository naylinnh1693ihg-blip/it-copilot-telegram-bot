import path from "node:path";
import express, { type RequestHandler } from "express";
import type { Deps } from "../app/deps.js";
import { adminAppEnabled } from "../config/env.js";
import { processDueReminders } from "../jobs/processReminders.js";
import { createRateLimiter, secretsMatch } from "../utils/security.js";
import { createAdminRouter } from "./admin/index.js";
import { sendFormDocument } from "./formPage.js";
import { createMiniAppApi } from "./forms.js";
import { createMetrics } from "./metrics.js";
import { redactString } from "../utils/text.js";

/** Authenticated calls per minute per caller to POST /internal/reminders/process. */
export const REMINDER_TRIGGER_LIMIT_PER_MINUTE = 120;

export function createHttpApp(
  deps: Deps,
  options: {
    sendTelegram?: (
      chatId: number,
      text: string,
      buttons?: Array<{ label: string; data: string }>,
      options?: { threadId?: number },
    ) => Promise<{ messageId: number }>;
    webhook?: RequestHandler;
    adminStaticDir?: string;
  } = {},
): express.Express {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  const limiter = createRateLimiter(120, 60_000);
  // The reminder trigger has its own limiter, so webhook traffic can never use up its
  // budget. Supabase cron calls once a minute; 120 a minute per caller only stops a runaway
  // caller that already holds CRON_SECRET (the secret is checked first).
  const reminderLimiter = createRateLimiter(REMINDER_TRIGGER_LIMIT_PER_MINUTE, 60_000);
  const metrics = createMetrics();
  app.use(metrics.middleware);

  app.get("/health", (_req, res) => {
    res.status(200).json({ ok: true, service: "it-work-copilot" });
  });

  app.get("/metrics", metrics.handler);

  app.get("/health/ready", async (_req, res) => {
    const ping = await deps.db.ping();
    res.status(ping.ok ? 200 : 503).json({
      ok: ping.ok,
      database: ping.ok ? "reachable" : "not reachable",
      grok: deps.llm ? "configured" : "not configured",
    });
  });

  app.post("/internal/reminders/process", async (req, res) => {
    const provided = req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (!deps.env.CRON_SECRET || !secretsMatch(provided, deps.env.CRON_SECRET)) {
      res.status(401).json({ ok: false });
      return;
    }
    if (!reminderLimiter.allow(req.ip ?? "local", Date.now())) {
      res.status(429).json({ ok: false });
      return;
    }
    if (!options.sendTelegram) {
      res.status(503).json({ ok: false, error: "Telegram is not ready." });
      return;
    }
    try {
      const result = await processDueReminders(deps, { workerId: "http", source: "http", send: options.sendTelegram });
      // Counts only: never reminder text, user ids or anything from the request.
      res.status(200).json({ ok: true, sent: result.sent, failed: result.failed, skipped: result.skipped });
    } catch (error) {
      deps.logger.error({ event: "reminder_job_failed", message: redactString(error instanceof Error ? error.message : "error") }, "reminder job failed");
      res.status(500).json({ ok: false });
    }
  });

  if (options.webhook) {
    app.post("/telegram/webhook", (req, res, next) => {
      if (!secretsMatch(req.header("x-telegram-bot-api-secret-token"), deps.env.TELEGRAM_WEBHOOK_SECRET)) {
        res.status(401).json({ ok: false });
        return;
      }
      if (!limiter.allow(req.ip ?? "webhook", Date.now())) {
        res.status(429).json({ ok: false });
        return;
      }
      next();
    }, options.webhook);
  }

  app.use("/forms", express.static(path.resolve(process.cwd(), "public/forms"), { index: false, maxAge: "1h" }));
  app.use(
    "/api",
    createMiniAppApi(
      deps,
      options.sendTelegram ? (chatId, text) => options.sendTelegram!(chatId, text) : undefined,
    ),
  );
  app.get("/miniapp/:formId", (req, res) => {
    const formId = typeof req.params.formId === "string" ? req.params.formId : "";
    sendFormDocument(res, { formId, surface: "miniapp", apiBase: "/api" });
  });

  // Mounted only when enabled. Otherwise /admin falls through to Express's 404.
  if (adminAppEnabled(deps.env)) {
    app.use("/admin", createAdminRouter(deps, { staticDir: options.adminStaticDir }));
  }

  return app;
}
