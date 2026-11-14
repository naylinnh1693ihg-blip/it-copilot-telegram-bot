import { Counter, Histogram, Registry, collectDefaultMetrics } from "@prometheus-io/client";
import type { Request, RequestHandler } from "express";

const PREFIX = "it_work_";

export function createMetrics(): {
  middleware: RequestHandler;
  handler: RequestHandler;
} {
  const register = new Registry();
  collectDefaultMetrics({ register, prefix: PREFIX });

  const requests = new Counter({
    name: `${PREFIX}http_requests_total`,
    help: "HTTP requests handled by the app.",
    labelNames: ["method", "route", "status"] as const,
    registers: [register],
  });
  const errors = new Counter({
    name: `${PREFIX}http_errors_total`,
    help: "HTTP responses with status 500 or higher.",
    labelNames: ["method", "route", "status"] as const,
    registers: [register],
  });
  const duration = new Histogram({
    name: `${PREFIX}http_request_duration_seconds`,
    help: "HTTP request duration in seconds.",
    labelNames: ["method", "route"] as const,
    registers: [register],
  });

  const middleware: RequestHandler = (req, res, next) => {
    if (req.path === "/metrics") {
      next();
      return;
    }
    const started = process.hrtime.bigint();
    res.on("finish", () => {
      const route = routeLabel(req);
      const status = String(res.statusCode);
      requests.inc({ method: req.method, route, status });
      if (res.statusCode >= 500) errors.inc({ method: req.method, route, status });
      duration.observe({ method: req.method, route }, elapsedSeconds(started));
    });
    next();
  };

  const handler: RequestHandler = async (_req, res) => {
    res.set("Content-Type", register.contentType).send(await register.metrics());
  };

  return { middleware, handler };
}

function routeLabel(req: Request): string {
  const pattern = req.route?.path;
  if (typeof pattern !== "string") return "unmatched";
  return req.baseUrl ? `${req.baseUrl}${pattern}` : pattern;
}

function elapsedSeconds(started: bigint): number {
  return Number(process.hrtime.bigint() - started) / 1_000_000_000;
}
