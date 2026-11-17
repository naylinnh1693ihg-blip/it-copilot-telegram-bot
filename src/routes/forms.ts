import express, { type Request, type RequestHandler, type Response } from "express";
import type { Deps } from "../app/deps.js";
import { findForm, parseForm, publicForm } from "../forms/index.js";
import { confirmationText, listFormRecords, logFormFailure, saveFormRecord } from "../services/forms/records.js";
import { validateInitData } from "../services/telegram/initData.js";
import type { User } from "../types/models.js";
import { listBirthdayEntries } from "../services/forms/birthdays.js";
import { FormFieldError } from "../utils/errors.js";
import { createRateLimiter } from "../utils/security.js";
import { redactString } from "../utils/text.js";
import { toIso } from "../utils/time.js";

type SendTelegram = (chatId: number, text: string) => Promise<{ messageId: number }>;

function formIdFrom(req: Request): string {
  const value = req.params.formId;
  return typeof value === "string" ? value : "";
}

export async function ownerFromTelegram(deps: Deps, telegramUserId: number): Promise<User | null> {
  if (!deps.env.TELEGRAM_OWNER_ID || String(telegramUserId) !== deps.env.TELEGRAM_OWNER_ID) return null;
  const existing = await deps.db.findUserByTelegram(telegramUserId);
  if (existing) return existing;
  return deps.db.upsertFromTelegram({
    telegramUserId,
    displayName: null,
    timezone: deps.env.APP_TIMEZONE,
    startedBot: true,
    at: toIso(deps.clock.now()),
  });
}

export function registerFormHandlers(
  router: express.Router,
  deps: Deps,
  options: {
    currentUser: (res: Response) => User;
    source: "admin" | "miniapp";
    sendTelegram?: SendTelegram;
    wrap: (run: (req: Request, res: Response) => Promise<void>) => RequestHandler;
  },
): void {
  router.get(
    "/forms/:formId",
    options.wrap(async (req, res) => {
      const form = findForm(formIdFrom(req));
      if (!form) {
        res.status(404).json({ error: "That form does not exist." });
        return;
      }
      res.json(publicForm(form));
    }),
  );

  router.get(
    "/records/:formId",
    options.wrap(async (req, res) => {
      const user = options.currentUser(res);
      const formId = formIdFrom(req);
      if (formId === "birthdays") {
        const scope = req.query.scope === "month" ? "month" : "upcoming";
        const entries = await listBirthdayEntries(deps, user, scope);
        res.json({
          records: entries.map((entry) => ({
            number: entry.number,
            title: entry.name,
            detail: entry.department,
            createdAt: entry.sortAt,
            columns: [entry.name, entry.department, entry.dateLabel, entry.when, entry.age == null ? "" : String(entry.age)],
          })),
        });
        return;
      }
      const form = findForm(formId);
      if (!form) {
        res.status(404).json({ error: "That form does not exist." });
        return;
      }
      const query = typeof req.query.q === "string" ? req.query.q : "";
      const subnet = typeof req.query.subnet === "string" ? req.query.subnet : "";
      const records = await listFormRecords(deps, user.id, form.id, query, subnet);
      res.json({ records });
    }),
  );

  router.post(
    "/forms/:formId",
    options.wrap(async (req, res) => {
      const form = findForm(formIdFrom(req));
      if (!form) {
        res.status(404).json({ error: "That form does not exist." });
        return;
      }
      const user = options.currentUser(res);
      const parsed = parseForm(form.fields, req.body);
      if (!parsed.ok) {
        res.status(422).json({ errors: parsed.errors });
        return;
      }
      try {
        const saved = await saveFormRecord(deps, user, form.id, parsed.data);
        await deps.db
          .writeAudit({
            userId: user.id,
            action: `${form.id}.create`,
            entity: form.id,
            entityId: null,
            metadata: { number: saved.number, source: options.source },
            createdAt: toIso(deps.clock.now()),
          })
          .catch((error: unknown) => logFormFailure(deps, error));
        if (options.source === "miniapp" && options.sendTelegram) {
          try {
            await options.sendTelegram(user.telegramUserId, confirmationText(form.id, saved));
          } catch (error) {
            logFormFailure(deps, error);
          }
        }
        res.status(201).json({ number: saved.number, summary: saved.summary });
      } catch (error) {
        if (error instanceof FormFieldError) {
          res.status(422).json({ errors: { [error.field]: error.message } });
          return;
        }
        throw error;
      }
    }),
  );
}

/** Mini App API. The admin session cookie is ignored here; only X-Telegram-Init-Data is accepted. */
export function createMiniAppApi(deps: Deps, sendTelegram?: SendTelegram): express.Router {
  const router = express.Router();
  const limiter = createRateLimiter(60, 60_000);
  const failures = createRateLimiter(30, 60_000);
  router.use((req, res, next) => {
    const now = Math.floor(deps.clock.now().toSeconds());
    const result = validateInitData(req.header("x-telegram-init-data") ?? "", deps.env.TELEGRAM_BOT_TOKEN, now);
    if (!result.ok) {
      if (!failures.allow(req.ip ?? "unknown", Date.now())) {
        res.status(429).json({ error: "Too many requests. Wait a minute and try again." });
        return;
      }
      res.status(result.status).json({ error: result.error });
      return;
    }
    ownerFromTelegram(deps, result.telegramUserId)
      .then((user) => {
        if (!user) {
          res.status(401).json({ error: "This form is only available to the owner." });
          return;
        }
        if (!limiter.allow(user.id, Date.now())) {
          res.status(429).json({ error: "Too many requests. Wait a minute and try again." });
          return;
        }
        res.locals.formUser = user;
        next();
      })
      .catch((error: unknown) => {
        deps.logger.error(
          { event: "miniapp_auth_failed", message: redactString(error instanceof Error ? error.message : "error") },
          "mini app auth failed",
        );
        if (!res.headersSent) res.status(500).json({ error: "Could not check this Telegram session." });
      });
  });

  registerFormHandlers(router, deps, {
    source: "miniapp",
    sendTelegram,
    currentUser: (res) => {
      const user = res.locals.formUser as User | undefined;
      if (!user) throw new Error("Mini App user missing.");
      return user;
    },
    wrap: (run) => (req, res) => {
      run(req, res).catch((error: unknown) => {
        deps.logger.error(
          { event: "form_request_failed", message: redactString(error instanceof Error ? error.message : "error") },
          "form request failed",
        );
        if (!res.headersSent) res.status(500).json({ error: "Something went wrong. Nothing was saved unless the page says so." });
      });
    },
  });

  return router;
}
