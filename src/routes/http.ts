import express, { type RequestHandler } from "express";
import { collectDefaultMetrics, Counter, Histogram, Registry } from "@prometheus-io/client";
import type { Deps } from "../app/deps.js";
import { adminAppEnabled } from "../config/env.js";
import { processDueReminders } from "../jobs/processReminders.js";
import { createRateLimiter, secretsMatch } from "../utils/security.js";
import { createAdminRouter } from "./admin/index.js";
import { redactString } from "../utils/text.js";

export function createHttpApp(
  deps: Deps,
  options: {
    sendTelegram?: (telegramUserId: number, text: string, buttons?: Array<{ label: string; data: string }>) => Promise<{ messageId: number }>;
    webhook?: RequestHandler;
    adminStaticDir?: string;
  } = {},
): express.Express {
  const app = express();
  const metrics = new Registry();
  collectDefaultMetrics({ register: metrics, prefix: "it_work_" });
  const requests = new Counter({
    name: "it_work_http_requests_total",
    help: "Total HTTP requests served by the application.",
    labelNames: ["method", "route", "status"] as const,
    registers: [metrics],
  });
  const errors = new Counter({
    name: "it_work_http_errors_total",
    help: "Total HTTP responses with a 5xx status.",
    labelNames: ["method", "route", "status"] as const,
    registers: [metrics],
  });
  const duration = new Histogram({
    name: "it_work_http_request_duration_seconds",
    help: "HTTP request duration in seconds.",
    labelNames: ["method", "route"] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
    registers: [metrics],
  });
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    const startedAt = process.hrtime.bigint();
    res.on("finish", () => {
      if (req.path === "/metrics") return;
      const matchedRoute = req.route?.path;
      const route = typeof matchedRoute === "string" ? `${req.baseUrl}${matchedRoute}` : "unmatched";
      const status = String(res.statusCode);
      requests.inc({ method: req.method, route, status });
      duration.observe(
        { method: req.method, route },
        Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
      );
      if (res.statusCode >= 500) errors.inc({ method: req.method, route, status });
    });
    next();
  });
  app.use(express.json({ limit: "1mb" }));
  const limiter = createRateLimiter(120, 60_000);

  app.get("/metrics", async (_req, res) => {
    res.set("Content-Type", metrics.contentType);
    res.status(200).send(await metrics.metrics());
  });

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
    const provided = req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (!deps.env.CRON_SECRET || !secretsMatch(provided, deps.env.CRON_SECRET)) {
      res.status(401).json({ ok: false });
      return;
    }
    if (!limiter.allow(req.ip ?? "local", Date.now())) {
      res.status(429).json({ ok: false });
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

  // Mounted only when enabled. Otherwise /admin falls through to Express's 404.
  if (adminAppEnabled(deps.env)) {
    app.use("/admin", createAdminRouter(deps, { staticDir: options.adminStaticDir }));
  }

  return app;
}
