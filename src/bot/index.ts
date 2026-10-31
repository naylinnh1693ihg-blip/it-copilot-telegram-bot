import { Bot, webhookCallback, type Context } from "grammy";
import type { Deps } from "../app/deps.js";
import { saveDocument } from "../services/documents/documentService.js";
import { downloadTelegramFile, uploadLimit } from "../services/documents/telegramDownload.js";
import { matchCategory } from "../services/knowledge/categories.js";
import { handleText } from "../services/assistant/handleText.js";
import { execute } from "../services/assistant/execute.js";
import { blankIntent } from "../types/intent.js";
import { AppError, toUserMessage } from "../utils/errors.js";
import { authorize } from "./middleware/auth.js";
import { claimTelegramUpdate } from "./middleware/dedupe.js";
import { createRateLimiter } from "../utils/security.js";
import { redactString } from "../utils/text.js";
import { toIso } from "../utils/time.js";
import { tasksPhrase } from "./commands/arguments.js";
import { buildStatus, currentUser, rememberUser, sendReply } from "./handlers/messages.js";

function captionPlan(caption: string | undefined, filename: string): { title: string; summarize: boolean } {
  const text = caption?.trim() ?? "";
  const named = text.match(/^save this as\s+(.+)$/i);
  const requestedTitle = (named?.[1] ?? text).replace(/\s*(?:[-,:;]\s*)?(?:and\s+)?(?:summarize|summarise|analyze|analyse)\s*$/i, "").trim();
  return {
    title: (requestedTitle || filename).slice(0, 160),
    summarize: /\b(summar(?:ize|ise|y)|analy[sz]e|analysis)\b/i.test(text),
  };
}

async function runText(deps: Deps, ctx: Context, text: string): Promise<void> {
  const reply = await handleText(deps, currentUser(ctx), text);
  await sendReply(ctx, reply);
}

export function createBot(token: string, deps: Deps): Bot {
  const bot = new Bot(token);
  const limiter = createRateLimiter(20, 10_000);

  bot.use(async (ctx, next) => {
    try {
      const claimed = await claimTelegramUpdate(deps.db, ctx.update.update_id, ctx.from?.id ?? null, toIso(deps.clock.now()));
      if (!claimed) return;
      const decision = authorize({
        ownerId: deps.env.TELEGRAM_OWNER_ID,
        fromId: ctx.from?.id,
        chatType: ctx.chat?.type,
      });
      if (!decision.ok) {
        await ctx.reply(decision.message);
        return;
      }
      if (!ctx.from || !limiter.allow(String(ctx.from.id), Date.now())) {
        await ctx.reply("You're sending messages very quickly. Wait a moment and try again.");
        return;
      }
      const user = await deps.db.upsertFromTelegram({
        telegramUserId: ctx.from.id,
        displayName: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") || null,
        timezone: deps.env.APP_TIMEZONE,
        startedBot: true,
        at: toIso(deps.clock.now()),
      });
      rememberUser(ctx, user);
      await next();
    } catch (error) {
      deps.logger.error({ event: "bot_failed", message: redactString(error instanceof Error ? error.message : "error") }, "bot failed");
      await ctx.reply(toUserMessage(error)).catch(() => undefined);
    }
  });

  bot.command("start", async (ctx) => {
    await sendReply(ctx, { text: "Hello. I'm your private IT work copilot.\n\n" + (await handleText(deps, currentUser(ctx), "help")).text, keyboard: "menu" });
  });
  bot.command("help", (ctx) => runText(deps, ctx, "help"));
  bot.command("menu", (ctx) => runText(deps, ctx, "help"));
  bot.command("status", async (ctx) => {
    const ping = await deps.db.ping();
    await sendReply(ctx, { text: buildStatus(deps, ping.ok ? "reachable" : "not reachable") });
  });
  bot.command("tasks", (ctx) => runText(deps, ctx, tasksPhrase(String(ctx.match).trim())));
  bot.command("reminders", (ctx) => runText(deps, ctx, "list my reminders"));
  bot.command("notes", async (ctx) => {
    const notes = await deps.db.listNotes(currentUser(ctx).id);
    await ctx.reply(notes.length ? notes.slice(-10).map((note) => `${note.noteNumber}. ${note.title}`).join("\n") : "You have no saved notes.");
  });
  bot.command("documents", async (ctx) => {
    const documents = await deps.db.listDocuments(currentUser(ctx).id);
    await ctx.reply(documents.length ? documents.slice(-10).map((document) => `${document.documentNumber}. ${document.title}`).join("\n") : "You have no saved documents.");
  });

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    await ctx.answerCallbackQuery();
    const action =
      data === "m:today" ? "Show today's tasks"
      : data === "m:pending" ? "Show my pending tasks"
      : data === "m:reminders" ? "list my reminders"
      : data === "m:notes" ? "help"
      : data === "m:docs" ? "search my documents files"
      : data === "m:summary" ? "Give me my daily summary"
      : data === "c:yes" ? "YES"
      : data === "c:no" ? "NO"
      : "";
    if (!action) return;
    if (data === "m:notes") {
      const notes = await deps.db.listNotes(currentUser(ctx).id);
      await ctx.reply(notes.length ? notes.slice(-10).map((note) => `${note.noteNumber}. ${note.title}`).join("\n") : "You have no saved notes.");
      return;
    }
    if (data === "m:docs") {
      const documents = await deps.db.listDocuments(currentUser(ctx).id);
      await ctx.reply(documents.length ? documents.slice(-10).map((document) => `${document.documentNumber}. ${document.title}`).join("\n") : "You have no saved documents.");
      return;
    }
    await runText(deps, ctx, action);
  });

  bot.on("message:document", async (ctx) => {
    const document = ctx.message.document;
    await storeFile(deps, ctx, {
      fileId: document.file_id,
      fileSize: document.file_size,
      filename: document.file_name ?? "file",
      mime: document.mime_type ?? "application/octet-stream",
      caption: ctx.message.caption,
    });
  });

  bot.on("message:photo", async (ctx) => {
    const photo = ctx.message.photo.at(-1);
    if (!photo) return;
    await storeFile(deps, ctx, {
      fileId: photo.file_id,
      fileSize: photo.file_size,
      filename: "photo.jpg",
      mime: "image/jpeg",
      caption: ctx.message.caption,
    });
  });

  bot.on("message:text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) return;
    await runText(deps, ctx, ctx.message.text);
  });

  bot.catch((error) => {
    deps.logger.error({ event: "bot_catch", message: redactString(error.message) }, "bot catch");
  });

  return bot;
}

async function storeFile(
  deps: Deps,
  ctx: Context,
  file: { fileId: string; fileSize?: number; filename: string; mime: string; caption?: string },
): Promise<void> {
  const plan = captionPlan(file.caption, file.filename);
  let saved: Awaited<ReturnType<typeof saveDocument>>;
  try {
    const buffer = await downloadTelegramFile({
      token: deps.env.TELEGRAM_BOT_TOKEN,
      apiRoot: deps.env.TELEGRAM_API_ROOT,
      fileId: file.fileId,
      fileSize: file.fileSize,
      maxBytes: uploadLimit(deps.env),
    });
    saved = await saveDocument(deps, currentUser(ctx), {
      filename: file.filename,
      declaredMime: file.mime,
      buffer,
      title: plan.title,
      category: matchCategory(`${file.caption ?? ""} ${file.filename}`),
    });
  } catch (error) {
    await ctx.reply(error instanceof AppError ? error.userMessage : "I could not store that file. Nothing was saved.");
    return;
  }

  const imageWithoutText = saved.document.mimeType.startsWith("image/") && !saved.text.trim();
  if (saved.duplicate) {
    await ctx.reply(
      `You already saved this file as document ${saved.document.documentNumber}: ${saved.document.title}.${imageWithoutText ? "\nI couldn't detect readable text in the image. Try a clearer image to enable search and analysis." : ""}`,
    );
  } else {
    await ctx.reply(
      `Stored document ${saved.document.documentNumber}: ${saved.document.title}.${imageWithoutText ? "\nI couldn't detect readable text in the image. Try a clearer image to enable search and analysis." : ""}`,
    );
  }
  if (!plan.summarize || imageWithoutText) return;

  try {
    const reply = await execute(deps, currentUser(ctx), blankIntent({ intent: "summarize_document", entity_number: saved.document.documentNumber }), { confirmed: false });
    await sendReply(ctx, reply);
  } catch (error) {
    deps.logger.error({ event: "document_analysis_failed", message: redactString(error instanceof Error ? error.message : "error") }, "document analysis failed");
    await ctx.reply(toUserMessage(error));
  }
}

export function telegramWebhook(bot: Bot, secret: string) {
  return webhookCallback(bot, "express", { secretToken: secret, timeoutMilliseconds: 120_000 });
}
