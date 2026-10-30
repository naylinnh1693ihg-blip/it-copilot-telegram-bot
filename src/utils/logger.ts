import pino from "pino";
import { redactString } from "./text.js";

export interface AppLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
  debug(obj: Record<string, unknown>, msg?: string): void;
}

function safe(obj: Record<string, unknown>, msg?: string): { obj: Record<string, unknown>; msg?: string } {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    redacted[key] = typeof value === "string" ? redactString(value) : value;
  }
  return { obj: redacted, msg: msg ? redactString(msg) : undefined };
}

export function createLogger(level: string): AppLogger {
  const logger = pino({
    level,
    redact: {
      paths: ["req.headers.authorization", "apiKey", "token", "serviceRoleKey"],
      censor: "[redacted]",
    },
  });
  return {
    info(obj, msg) {
      const cleaned = safe(obj, msg);
      logger.info(cleaned.obj, cleaned.msg);
    },
    warn(obj, msg) {
      const cleaned = safe(obj, msg);
      logger.warn(cleaned.obj, cleaned.msg);
    },
    error(obj, msg) {
      const cleaned = safe(obj, msg);
      logger.error(cleaned.obj, cleaned.msg);
    },
    debug(obj, msg) {
      const cleaned = safe(obj, msg);
      logger.debug(cleaned.obj, cleaned.msg);
    },
  };
}

export const silentLogger: AppLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};
