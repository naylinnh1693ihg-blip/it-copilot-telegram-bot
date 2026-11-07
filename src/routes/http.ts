import express, { type RequestHandler } from "express";
import type { Deps } from "../app/deps.js";
import { processDueReminders } from "../jobs/processReminders.js";
import { createRateLimiter, secretsMatch } from "../utils/security.js";
import { redactString } from "../utils/text.js";

export function createHttpApp(
  deps: Deps,
  options: {
    sendTelegram?: (telegramUserId: number, text: string, buttons?: Array<{ label: string; data: string }>) => Promise<{ messageId: number }>;
    webhook?: RequestHandler;
  } = {},
): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  const limiter = createRateLimiter(120, 60_000);

  app.get("/health", (_req, res) => {
    res.status(200).json({ ok: true, service: "it-work-copilot" });
  });

  app.get("/health/ready", async (_req, res) => {
    const ping = await deps.db.ping();
    res.status(ping.ok ? 200 : 503).json({
      ok: ping.ok,
      database: ping.ok ? "reachable" : "not reachable",
      grok: deps.llm ? "configured" : "not configured",
    });
  });

  app.post("/internal/reminders/process", async (req, res) => {
    if (!limiter.allow(req.ip ?? "local", Date.now())) {
      res.status(429).json({ ok: false });
      return;
    }
    const provided = req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (!deps.env.CRON_SECRET || !secretsMatch(provided, deps.env.CRON_SECRET)) {
      res.status(401).json({ ok: false });
      return;
    }
    if (!options.sendTelegram) {
      res.status(503).json({ ok: false, error: "Telegram is not ready." });
      return;
    }
    try {
      const result = await processDueReminders(deps, { workerId: "http", send: options.sendTelegram });
      res.status(200).json({ ok: true, ...result });
    } catch (error) {
      deps.logger.error({ event: "reminder_job_failed", message: redactString(error instanceof Error ? error.message : "error") }, "reminder job failed");
      res.status(500).json({ ok: false });
    }
  });

  if (options.webhook) {
    app.post("/telegram/webhook", (req, res, next) => {
      if (!limiter.allow(req.ip ?? "webhook", Date.now())) {
        res.status(429).json({ ok: false });
        return;
      }
      if (!secretsMatch(req.header("x-telegram-bot-api-secret-token"), deps.env.TELEGRAM_WEBHOOK_SECRET)) {
        res.status(401).json({ ok: false });
        return;
      }
      next();
    }, options.webhook);
  }

  return app;
}
