import { existsSync } from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";
import type { Deps } from "../../app/deps.js";
import {
  type ActiveSession,
  adminBaseUrl,
  authenticate,
  csrfMatches,
  csrfTokenFor,
  logout,
  redeemLoginToken,
  SESSION_DAYS,
} from "../../services/admin/auth.js";
import { createRateLimiter } from "../../utils/security.js";
import { redactString } from "../../utils/text.js";

export const SESSION_COOKIE = "admin_session";
const COOKIE_PATH = "/admin";

export interface AdminRouterOptions {
  /** Built frontend. Defaults to dist/admin under the working directory. */
  staticDir?: string;
}

/** Strict headers for every /admin response. The SPA loads only same-origin scripts and styles. */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const value = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function secureCookies(deps: Deps): boolean {
  return deps.env.NODE_ENV === "production" || adminBaseUrl(deps).startsWith("https://");
}

function setSessionCookie(deps: Deps, res: Response, sessionId: string): void {
  res.cookie(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: secureCookies(deps),
    sameSite: "lax",
    path: COOKIE_PATH,
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
  });
}

function clearSessionCookie(deps: Deps, res: Response): void {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: secureCookies(deps), sameSite: "lax", path: COOKIE_PATH });
}

/** Local state set by requireAdminSession. Routes read the user from here, never from the request. */
export function activeSession(res: Response): ActiveSession {
  const active = res.locals.admin as ActiveSession | undefined;
  if (!active) throw new Error("Admin session missing.");
  return active;
}

export function sessionIdFrom(req: Request): string | undefined {
  return readCookie(req.header("cookie"), SESSION_COOKIE);
}

type AsyncHandler = (req: Request, res: Response) => Promise<void>;

function handle(deps: Deps, run: AsyncHandler): RequestHandler {
  return (req, res) => {
    run(req, res).catch((error: unknown) => {
      deps.logger.error(
        { event: "admin_request_failed", path: req.path, message: redactString(error instanceof Error ? error.message : "error") },
        "admin request failed",
      );
      if (!res.headersSent) res.status(500).json({ error: "Something went wrong. Nothing was changed unless the page says so." });
    });
  };
}

const MagicLoginBody = z.object({ token: z.string().min(20).max(128) });

export function createAdminRouter(deps: Deps, options: AdminRouterOptions = {}): express.Router {
  const router = express.Router();
  const loginLimiter = createRateLimiter(10, 15 * 60_000);
  const readLimiter = createRateLimiter(300, 60_000);
  const writeLimiter = createRateLimiter(60, 60_000);
  const expectedOrigin = new URL(adminBaseUrl(deps)).origin;

  router.use(securityHeaders);

  const api = express.Router();
  api.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (!readLimiter.allow(`read:${req.ip ?? "unknown"}`, Date.now())) {
      res.status(429).json({ error: "Too many requests. Wait a minute and try again." });
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      // Browsers always send Origin on cross-site POSTs. A mismatch is a forged request.
      const origin = req.header("origin");
      if (origin && origin !== expectedOrigin) {
        res.status(403).json({ error: "This request came from another site." });
        return;
      }
      if (!req.is("application/json")) {
        res.status(415).json({ error: "Send JSON." });
        return;
      }
    }
    next();
  });

  api.post(
    "/auth/magic",
    handle(deps, async (req, res) => {
      if (!loginLimiter.allow(`login:${req.ip ?? "unknown"}`, Date.now())) {
        res.status(429).json({ error: "Too many sign-in attempts. Wait 15 minutes and try again." });
        return;
      }
      const body = MagicLoginBody.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: "That sign-in link is not valid." });
        return;
      }
      const created = await redeemLoginToken(deps, body.data.token, req.header("user-agent") ?? null);
      if (!created) {
        res.status(401).json({ error: "That sign-in link has expired or was already used. Send /admin to the bot for a new one." });
        return;
      }
      setSessionCookie(deps, res, created.sessionId);
      res.status(200).json({ user: publicUser(created.user), csrfToken: created.csrfToken });
    }),
  );

  const requireAdminSession: RequestHandler = (req, res, next) => {
    const sessionId = sessionIdFrom(req);
    authenticate(deps, sessionId)
      .then((active) => {
        if (!active || !sessionId) {
          clearSessionCookie(deps, res);
          res.status(401).json({ error: "Sign in again. Send /admin to the bot for a link." });
          return;
        }
        res.locals.admin = active;
        res.locals.sessionId = sessionId;
        if (req.method !== "GET" && req.method !== "HEAD") {
          if (!csrfMatches(deps, sessionId, req.header("x-csrf-token"))) {
            res.status(403).json({ error: "Your session token is missing or out of date. Reload the page." });
            return;
          }
          if (!writeLimiter.allow(`write:${active.session.id}`, Date.now())) {
            res.status(429).json({ error: "Too many changes in a minute. Wait and try again." });
            return;
          }
        }
        // Refresh the cookie lifetime alongside the server-side sliding expiry.
        setSessionCookie(deps, res, sessionId);
        next();
      })
      .catch((error: unknown) => {
        deps.logger.error({ event: "admin_auth_failed", message: redactString(error instanceof Error ? error.message : "error") }, "admin auth failed");
        res.status(500).json({ error: "Could not check your session." });
      });
  };

  api.use(requireAdminSession);

  api.get(
    "/auth/session",
    handle(deps, async (_req, res) => {
      const active = activeSession(res);
      res.json({ user: publicUser(active.user), csrfToken: csrfTokenFor(deps, String(res.locals.sessionId)), expiresAt: active.session.expiresAt });
    }),
  );

  api.post(
    "/auth/logout",
    handle(deps, async (_req, res) => {
      await logout(deps, activeSession(res));
      clearSessionCookie(deps, res);
      res.json({ ok: true });
    }),
  );

  api.get(
    "/activity",
    handle(deps, async (_req, res) => {
      const { user } = activeSession(res);
      const entries = await deps.db.listAudit(user.id, 20);
      res.json({
        entries: entries.map((entry) => ({ action: entry.action, entity: entry.entity, createdAt: entry.createdAt })),
      });
    }),
  );

  api.use((_req, res) => {
    res.status(404).json({ error: "Not found." });
  });

  router.use("/api", api);

  const staticDir = options.staticDir ?? path.resolve(process.cwd(), "dist/admin");
  router.use(express.static(staticDir, { index: false, fallthrough: true, maxAge: "1h" }));
  router.get(/.*/, (_req, res) => {
    const index = path.join(staticDir, "index.html");
    if (!existsSync(index)) {
      res.status(503).type("text/plain").send("The admin app has not been built. Run npm run build.");
      return;
    }
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(index);
  });

  return router;
}

function publicUser(user: ActiveSession["user"]): { displayName: string | null; role: string } {
  return { displayName: user.displayName, role: user.role };
}
