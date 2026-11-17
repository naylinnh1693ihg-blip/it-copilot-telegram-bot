import { Bot, webhookCallback, type Context } from "grammy";
import type { Update } from "grammy/types";
import type { Deps } from "../app/deps.js";
import type { Env } from "../config/env.js";
import { saveDocument } from "../services/documents/documentService.js";
import { downloadTelegramFile, uploadLimit } from "../services/documents/telegramDownload.js";
import { matchCategory } from "../services/knowledge/categories.js";
import { handleText } from "../services/assistant/handleText.js";
import { execute, type Reply } from "../services/assistant/execute.js";
import { blankIntent } from "../types/intent.js";
import { AppError, toUserMessage } from "../utils/errors.js";
import { authorize } from "./middleware/auth.js";
import { claimTelegramUpdate } from "./middleware/dedupe.js";
import { telegramRetry } from "./telegramRetry.js";
import { createDraftStream, registerGeneration, runInChatQueue, stopGeneration } from "./draftStream.js";
import { withAbortSignal } from "../services/grok/abort.js";
import { withChatContext } from "../app/chatContext.js";
import { isGenerationStopped } from "../utils/errors.js";
import { createRateLimiter } from "../utils/security.js";
import { redactString } from "../utils/text.js";
import { toIso } from "../utils/time.js";
import { tasksPhrase } from "./commands/arguments.js";
import { buildStatus, createLiveAnalysis, currentUser, ephemeralTarget, keepChatAction, rememberUser, type ChatAction, sendReply } from "./handlers/messages.js";
import { applyReminderButton, parseReminderCallback } from "../services/reminders/buttons.js";
import { issueLoginLink, LOGIN_TOKEN_MINUTES } from "../services/admin/auth.js";
import { sendAddMenu } from "./addForms.js";

/**
 * Update types the bot handles. Used for both setWebhook and long polling, so Telegram
 * never sends (and we never write dedupe rows for) anything else.
 * "stopped_message_generation" is the Stop button on a streamed draft.
 */
export const ALLOWED_UPDATES = ["message", "callback_query", "my_chat_member", "stopped_message_generation"] as const satisfies ReadonlyArray<
  Exclude<keyof Update, "update_id">
>;

/** setWebhook options. Deliberately no drop_pending_updates: messages sent during a deploy must still arrive. */
export function webhookOptions(env: Pick<Env, "TELEGRAM_WEBHOOK_SECRET" | "TELEGRAM_WEBHOOK_MAX_CONNECTIONS">) {
  return {
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ALLOWED_UPDATES,
    max_connections: env.TELEGRAM_WEBHOOK_MAX_CONNECTIONS,
  };
}

/** Only messages and button taps get a reply. my_chat_member can come from a chat that just blocked or removed the bot. */
function canReply(ctx: Context): boolean {
  return Boolean(ctx.message || ctx.callbackQuery);
}

function captionPlan(caption: string | undefined, filename: string): { title: string; summarize: boolean } {
  const text = caption?.trim() ?? "";
  const named = text.match(/^save this as\s+(.+)$/i);
  const requestedTitle = (named?.[1] ?? text).replace(/\s*(?:[-,:;]\s*)?(?:and\s+)?(?:summarize|summarise|analyze|analyse)\s*$/i, "").trim();
  return {
    title: (requestedTitle || filename).slice(0, 160),
    summarize: /\b(summar(?:ize|ise|y)|analy[sz]e|analysis)\b/i.test(text),
  };
}

/**
 * In a group, privacy mode delivers only messages that mention or reply to the bot.
 * "@copilot_bot extension for Alex" must reach the parser as "extension for Alex".
 */
export function withoutMention(text: string, username: string): string {
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Only the mention (and one space after it) goes; line breaks in multi-line lists stay.
  return text.replace(new RegExp(`(^|\\s)@${escaped}\\b[,:]? ?`, "gi"), "$1").trim();
}

const IN_CHAT = new Set(["member", "administrator", "creator", "restricted"]);

/**
 * Logs membership changes. When the bot is added to any group or channel other than the
 * team group, it leaves straight away. Losing the team group is logged as a warning.
 */
export async function handleMembership(deps: Deps, ctx: Context): Promise<void> {
  const update = ctx.myChatMember;
  if (!update) return;
  const status = update.new_chat_member.status;
  const chat = update.chat;
  deps.logger.info({ event: "bot_membership", status, chatType: chat.type }, "bot membership changed");
  if (chat.type === "private") return;
  const isTeamGroup = deps.env.TELEGRAM_TEAM_CHAT_ID !== "" && String(chat.id) === deps.env.TELEGRAM_TEAM_CHAT_ID;
  if (isTeamGroup) {
    if (!IN_CHAT.has(status)) {
      deps.logger.warn({ event: "team_group_removed", status }, "the bot was removed from the team group");
    }
    return;
  }
  if (!IN_CHAT.has(status)) return;
  try {
    await ctx.api.leaveChat(chat.id);
    deps.logger.info({ event: "left_unknown_chat", chatType: chat.type }, "left a chat that is not the team group");
  } catch (error) {
    deps.logger.warn(
      { event: "leave_chat_failed", chatType: chat.type, message: redactString(error instanceof Error ? error.message : "leave failed") },
      "could not leave the chat",
    );
  }
}

async function notesList(deps: Deps, ctx: Context): Promise<string> {
  const notes = await deps.db.listNotes(currentUser(ctx).id);
  return notes.length ? notes.slice(-10).map((note) => `${note.noteNumber}. ${note.title}`).join("\n") : "You have no saved notes.";
}

async function documentsList(deps: Deps, ctx: Context): Promise<string> {
  const documents = await deps.db.listDocuments(currentUser(ctx).id);
  return documents.length ? documents.slice(-10).map((document) => `${document.documentNumber}. ${document.title}`).join("\n") : "You have no saved documents.";
}

/**
 * Sends a reply where it belongs. In the team group a lookup goes to the asker as an
 * ephemeral message. Ephemeral delivery isn't guaranteed, so this is only for lookups the
 * user can simply ask again; saves, deletes, reminders and confirmations are never marked
 * as lookups and are sent normally. If the ephemeral send fails, the answer goes to the
 * asker's private chat, never to the group.
 */
export async function respond(deps: Deps, ctx: Context, reply: Reply): Promise<void> {
  const ephemeral = ephemeralTarget(ctx, reply);
  if (!ephemeral) {
    await sendReply(ctx, reply, deps.logger);
    return;
  }
  try {
    await sendReply(ctx, reply, deps.logger, { ephemeral });
  } catch (error) {
    deps.logger.warn(
      { event: "ephemeral_send_failed", message: redactString(error instanceof Error ? error.message : "ephemeral send failed") },
      "ephemeral answer failed; trying the private chat",
    );
    await sendPrivately(deps, ctx, reply);
    return;
  }
  if (deps.env.TELEGRAM_EPHEMERAL_NOTICE) {
    await ctx.reply("Sent you the answer privately 👀").catch(() => undefined);
  }
}

/** The asker's private chat. If the bot can't message them there, the group gets a note with no content. */
async function sendPrivately(deps: Deps, ctx: Context, reply: Reply): Promise<void> {
  const userId = ctx.from?.id;
  try {
    if (!userId) throw new Error("No user to message.");
    const direct = {
      reply: (text: string, other?: object) => ctx.api.sendMessage(userId, text, other),
      replyWithRichMessage: (message: Parameters<Context["api"]["sendRichMessage"]>[1], other?: object) => ctx.api.sendRichMessage(userId, message, other),
    } as unknown as Context;
    await sendReply(direct, reply, deps.logger);
  } catch (error) {
    deps.logger.warn(
      { event: "private_fallback_failed", message: redactString(error instanceof Error ? error.message : "private send failed") },
      "could not send the answer privately",
    );
    await ctx.reply("I couldn't show you that privately. Send me a private message first, then ask again.");
  }
}

type Produce = (onAnalysisPreview: (plainText: string) => Promise<void>) => Promise<Reply>;

/**
 * Sends a reply that may take a while. Private chats stream with a native draft (with a
 * Stop button) and run in the background so the Stop update can arrive. Groups, where
 * drafts are not available, keep the edit-based preview.
 */
export async function deliver(deps: Deps, ctx: Context, produce: Produce): Promise<void> {
  const chat = ctx.chat;
  if (chat?.type === "private") {
    void runInChatQueue(chat.id, () => deliverDraft(deps, ctx, chat.id, produce));
    return;
  }
  await deliverEdited(deps, ctx, produce);
}

async function deliverDraft(deps: Deps, ctx: Context, chatId: number, produce: Produce): Promise<void> {
  // No chat action here: the draft's "Thinking…" placeholder already shows activity.
  const draft = createDraftStream(ctx, chatId, { minIntervalMs: deps.env.TELEGRAM_EDIT_INTERVAL_MS, logger: deps.logger });
  const generation = registerGeneration(chatId, draft.draftId);
  const stopped = async (): Promise<void> => {
    deps.logger.info({ event: "generation_stopped", partial: draft.partial().length > 0 }, "reply stopped by the user");
    const partial = draft.partial();
    // Never present a partial answer as complete.
    await sendReply(ctx, { text: partial ? `${partial}\n\n(Stopped.)` : "Stopped." });
  };
  try {
    const reply = await withAbortSignal(generation.signal, () => produce((plainText) => draft.update(plainText)));
    // A layer may have turned the abort into an ordinary reply; the user still pressed Stop.
    if (generation.signal.aborted) {
      draft.close();
      await stopped();
      return;
    }
    if (!(await draft.finish(reply))) await sendReply(ctx, reply, deps.logger);
  } catch (error) {
    draft.close();
    try {
      if (generation.signal.aborted || isGenerationStopped(error)) {
        await stopped();
        return;
      }
      deps.logger.error({ event: "reply_failed", message: redactString(error instanceof Error ? error.message : "error") }, "reply failed");
      await ctx.reply(toUserMessage(error));
    } catch (sendError) {
      // Nothing awaits a queued reply, so nothing else would log this.
      deps.logger.error({ event: "reply_send_failed", message: redactString(sendError instanceof Error ? sendError.message : "error") }, "could not send the reply");
    }
  } finally {
    draft.close();
    generation.release();
  }
}

async function deliverEdited(deps: Deps, ctx: Context, produce: Produce): Promise<void> {
  const live = createLiveAnalysis(ctx, { minIntervalMs: deps.env.TELEGRAM_EDIT_INTERVAL_MS, logger: deps.logger });
  // Grok is writing, so "typing" fits here even when the reply is about a file.
  const typing = keepChatAction(ctx, "typing");
  try {
    const reply = await produce((plainText) => live.update(plainText));
    if (!(await live.finish(reply))) await respond(deps, ctx, reply);
  } catch (error) {
    deps.logger.error({ event: "document_analysis_failed", message: redactString(error instanceof Error ? error.message : "error") }, "document analysis failed");
    const message = toUserMessage(error);
    if (!(await live.finish({ text: message }))) await ctx.reply(message);
  } finally {
    typing.stop();
  }
}

async function runText(deps: Deps, ctx: Context, text: string): Promise<void> {
  await deliver(deps, ctx, (onAnalysisPreview) => handleText(deps, currentUser(ctx), text, { onAnalysisPreview }));
}

export function createBot(token: string, deps: Deps): Bot {
  const bot = new Bot(token);
  // 429 retries for every API call, including bot.api.sendMessage in the reminder worker.
  bot.api.config.use(telegramRetry());
  const limiter = createRateLimiter(20, 10_000);

  bot.use(async (ctx, next) => {
    try {
      const claimed = await claimTelegramUpdate(deps.db, ctx.update.update_id, ctx.from?.id ?? null, toIso(deps.clock.now()));
      if (!claimed) return;
      // Membership changes are handled before authorization: when anyone (member or not) adds
      // the bot to a group that isn't the team group, the handler must still be able to leave.
      // Not rate-limited and no user upsert: "kicked" means the user blocked the bot.
      if (ctx.myChatMember) {
        await next();
        return;
      }
      // A Stop update has no `from`. It always comes from a private chat, whose id is the user's id.
      const stoppedIn = ctx.update.stopped_message_generation?.chat;
      const decision = authorize({
        ownerId: deps.env.TELEGRAM_OWNER_ID,
        teamIds: deps.env.TELEGRAM_TEAM_IDS,
        teamChatId: deps.env.TELEGRAM_TEAM_CHAT_ID,
        fromId: ctx.from?.id ?? (stoppedIn?.type === "private" ? stoppedIn.id : undefined),
        chatType: ctx.chat?.type,
        chatId: ctx.chat?.id,
      });
      if (!decision.ok) {
        if (canReply(ctx)) await ctx.reply(decision.message);
        return;
      }
      // Stop updates carry no sender to rate-limit or upsert.
      if (!canReply(ctx)) {
        await next();
        return;
      }
      if (!ctx.from || !limiter.allow(String(ctx.from.id), Date.now())) {
        if (canReply(ctx)) await ctx.reply("You're sending messages very quickly. Wait a moment and try again.");
        return;
      }
      const user = await deps.db.upsertFromTelegram({
        telegramUserId: ctx.from.id,
        displayName: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") || null,
        timezone: deps.env.APP_TIMEZONE,
        // Only a private message lets the bot message this person directly (reminders).
        // A team member who has only written in the group has not started the bot.
        startedBot: ctx.chat?.type === "private",
        at: toIso(deps.clock.now()),
      });
      rememberUser(ctx, user);
      const chat = ctx.chat;
      if (!chat) {
        await next();
        return;
      }
      const threadId = ctx.msg?.is_topic_message ? ctx.msg.message_thread_id : undefined;
      // Lets reminder creation record where to deliver (team group topic or private chat).
      await withChatContext({ chatId: chat.id, chatType: chat.type, ...(threadId ? { threadId } : {}) }, next);
    } catch (error) {
      deps.logger.error({ event: "bot_failed", message: redactString(error instanceof Error ? error.message : "error") }, "bot failed");
      if (canReply(ctx)) await ctx.reply(toUserMessage(error)).catch(() => undefined);
    }
  });

  // Never replies: the bot may have just been blocked or removed.
  bot.on("my_chat_member", (ctx) => handleMembership(deps, ctx));

  // Stop button on a streamed draft. Never replied to directly: the reply being stopped
  // sends the partial answer with "(Stopped.)".
  bot.on("stopped_message_generation", (ctx) => {
    const stop = ctx.stoppedMessageGeneration;
    const found = stopGeneration(stop.chat.id, stop.draft_id);
    deps.logger.info({ event: "generation_stop_requested", found }, "stop requested");
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
  bot.command("remember", (ctx) => runText(deps, ctx, `Remember that ${String(ctx.match).trim()}`));
  bot.command("memories", (ctx) => runText(deps, ctx, "list memories"));
  bot.command("forget", (ctx) => runText(deps, ctx, `forget ${String(ctx.match).trim()}`));
  bot.command("add", (ctx) => sendAddMenu(deps, ctx));
  bot.command("admin", async (ctx) => {
    // A one-time sign-in link must never be posted where other people can open it.
    if (ctx.chat.type !== "private") {
      await ctx.reply("Send /admin in a private chat with me. I don't post sign-in links in groups.");
      return;
    }
    const link = await issueLoginLink(deps, currentUser(ctx));
    if (!link.ok) {
      await ctx.reply(link.message);
      return;
    }
    // Previews stay off: a preview fetch must never be able to spend the one-time link.
    await ctx.reply(
      `Open the admin app:\n${link.url}\n\nThis link works once and expires in ${LOGIN_TOKEN_MINUTES} minutes. Don't forward it.`,
      { link_preview_options: { is_disabled: true } },
    );
  });
  bot.command("notes", async (ctx) => respond(deps, ctx, { text: await notesList(deps, ctx), lookup: true }));
  bot.command("documents", async (ctx) => respond(deps, ctx, { text: await documentsList(deps, ctx), lookup: true }));

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const reminderTap = parseReminderCallback(data);
    if (reminderTap) {
      const outcome = await applyReminderButton(deps, currentUser(ctx), reminderTap.action, reminderTap.reminderId);
      await ctx.answerCallbackQuery({ text: outcome.toast }).catch(() => undefined);
      if (outcome.editText) {
        try {
          await ctx.editMessageText(outcome.editText);
        } catch (error) {
          deps.logger.warn(
            { event: "reminder_edit_failed", reminderId: reminderTap.reminderId, message: redactString(error instanceof Error ? error.message : "edit failed") },
            "could not edit the reminder message",
          );
          await ctx.reply(outcome.text).catch(() => undefined);
        }
      }
      return;
    }
    if (data === "m:add") {
      await ctx.answerCallbackQuery();
      await sendAddMenu(deps, ctx);
      return;
    }
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
      await respond(deps, ctx, { text: await notesList(deps, ctx), lookup: true });
      return;
    }
    if (data === "m:docs") {
      await respond(deps, ctx, { text: await documentsList(deps, ctx), lookup: true });
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
      action: "upload_document",
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
      action: "upload_photo",
    });
  });

  bot.on("message:text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) return;
    const text = ctx.chat.type === "private" ? ctx.message.text : withoutMention(ctx.message.text, ctx.me.username);
    if (!text) return;
    await runText(deps, ctx, text);
  });

  bot.catch((error) => {
    deps.logger.error({ event: "bot_catch", message: redactString(error.message) }, "bot catch");
  });

  return bot;
}

type Reaction = Parameters<Context["react"]>[0];

/**
 * Sets (or with [] clears) the bot's reaction on the current message. Reactions are a
 * nice-to-have: a failure is logged and never interrupts the work they decorate.
 */
export async function safeReact(ctx: Pick<Context, "react">, reaction: Reaction, logger: Deps["logger"]): Promise<void> {
  try {
    await ctx.react(reaction);
  } catch (error) {
    logger.warn(
      { event: "telegram_reaction_failed", message: redactString(error instanceof Error ? error.message : "reaction failed") },
      "could not set the message reaction",
    );
  }
}

/**
 * Downloads, OCRs and stores a file from a message. 👀 while it works, then 👍 when saved
 * or 👌 when it was already saved. On failure the reaction is cleared so a file that was
 * not saved never shows 👍.
 */
export async function storeFile(
  deps: Deps,
  ctx: Context,
  file: { fileId: string; fileSize?: number; filename: string; mime: string; caption?: string; action: ChatAction },
): Promise<void> {
  const plan = captionPlan(file.caption, file.filename);
  await safeReact(ctx, "👀", deps.logger);
  // Shown while the file is downloaded, OCR'd and stored.
  const uploading = keepChatAction(ctx, file.action);
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
    await safeReact(ctx, [], deps.logger);
    await ctx.reply(error instanceof AppError ? error.userMessage : "I could not store that file. Nothing was saved.");
    return;
  } finally {
    uploading.stop();
  }
  await safeReact(ctx, saved.duplicate ? "👌" : "👍", deps.logger);

  const imageWithoutText = saved.document.mimeType.startsWith("image/") && !saved.text.trim();
  const ocrNote = imageWithoutText
    ? plan.summarize
      ? "\nOCR didn't find text. I'll ask Grok to look at the picture."
      : "\nOCR didn't find text. Send it again with the caption \"analyze\" and Grok will look at the picture."
    : "";
  if (saved.duplicate) {
    await ctx.reply(
      `You already saved this file as document ${saved.document.documentNumber}: ${saved.document.title}.${ocrNote}`,
    );
  } else {
    await ctx.reply(
      `Stored document ${saved.document.documentNumber}: ${saved.document.title}.${ocrNote}`,
    );
  }
  if (!plan.summarize) return;

  // Caption asked for a summary. execute() loads the extraction and summarizeDocument()
  // picks grok-4.7, the long-context model, or the longest model from the text length.
  // onAnalysisPreview streams Key Notes and Summary into one Telegram message.
  await deliver(deps, ctx, (onAnalysisPreview) =>
    execute(deps, currentUser(ctx), blankIntent({ intent: "summarize_document", entity_number: saved.document.documentNumber }), {
      confirmed: false,
      onAnalysisPreview,
    }),
  );
}

export function telegramWebhook(bot: Bot, secret: string) {
  return webhookCallback(bot, "express", { secretToken: secret, timeoutMilliseconds: 120_000 });
}
