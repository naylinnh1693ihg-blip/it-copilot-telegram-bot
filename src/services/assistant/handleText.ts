import type { Deps } from "../../app/deps.js";
import { IntentSchema, INTENT_JSON_SCHEMA, blankIntent, type Intent } from "../../types/intent.js";
import type { User } from "../../types/models.js";
import { intentPrompt } from "../grok/prompts.js";
import { AppError, GrokError, toUserMessage } from "../../utils/errors.js";
import { redactString } from "../../utils/text.js";
import { toIso } from "../../utils/time.js";
import { runGrokAgent, toolsForMessage } from "./agent.js";
import { execute, type Reply } from "./execute.js";
import { isConfidentLocalIntent, parseLocalIntent } from "./localIntent.js";
import { handleEquipment, parseEquipmentCommand } from "./equipment.js";
import { linkNoteCommand, parseNoteLinkCommand } from "../notes/links.js";
import { createManyTasks, extractLocalTasks, extractTasksWithGrok } from "./multiTask.js";
import { createManyReminders, extractLocalReminders, extractRemindersWithGrok } from "./multiReminder.js";
import { answerWithRag, looksLikeQuestion } from "../rag/retrieve.js";

async function interpret(deps: Deps, user: User, text: string): Promise<Intent> {
  // Daily phrases in DAILY_MATCHERS are confident and stop here. Grok runs only when this is null.
  const local = parseLocalIntent(text);
  if (isConfidentLocalIntent(local)) {
    deps.logger.info(
      {
        event: "intent_route",
        route: "local",
        intent: local.tags === "closed_today" || local.tags === "week_cost" ? local.tags : local.intent,
      },
      "message handled locally",
    );
    return local;
  }
  if (!deps.llm) {
    return (
      local ??
      blankIntent({
        intent: "clarify",
        clarification_question:
          "I can run the examples in /help. To understand other wording, report writing, and English rewriting, add XAI_API_KEY.",
      })
    );
  }
  deps.logger.info({ event: "intent_route", route: "grok" }, "message sent to Grok");
  try {
    const history = await deps.db.recentTurns(user.id, 8);
    const prompt = intentPrompt(history, text);
    const result = await deps.llm.completeStructured({
      system: prompt.system,
      user: prompt.user,
      schemaName: "copilot_intent",
      schema: INTENT_JSON_SCHEMA,
    });
    await deps.db.recordUsage({
      userId: user.id,
      model: deps.env.XAI_MODEL,
      purpose: "intent",
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      estimatedUsd:
        (result.inputTokens / 1_000_000) * deps.env.XAI_INPUT_USD_PER_MILLION +
        (result.outputTokens / 1_000_000) * deps.env.XAI_OUTPUT_USD_PER_MILLION,
      createdAt: toIso(deps.clock.now()),
    }).catch(() => undefined);
    const parsed = IntentSchema.safeParse(JSON.parse(result.text));
    if (!parsed.success) return local ?? blankIntent({ intent: "clarify", clarification_question: "I couldn't read that request. Please try /help." });
    if (parsed.data.confidence < 0.35) {
      return local ?? blankIntent({ intent: "clarify", clarification_question: parsed.data.clarification_question || "Can you say that more specifically?" });
    }
    return parsed.data;
  } catch (error) {
    deps.logger.warn({ event: "grok_intent_failed", message: redactString(error instanceof Error ? error.message : "error") }, "using local parser");
    if (local) return local;
    if (error instanceof GrokError) throw error;
    if (error instanceof AppError) {
      throw new AppError("Grok could not understand that message. Try a shorter request, or use /help.");
    }
    throw error;
  }
}

async function remember(deps: Deps, user: User, userText: string, assistantText: string): Promise<void> {
  const at = toIso(deps.clock.now());
  await deps.db.appendTurn(user.id, "user", userText, at);
  await deps.db.appendTurn(user.id, "assistant", assistantText, at);
}

export async function handleText(
  deps: Deps,
  user: User,
  text: string,
  options?: { onAnalysisPreview?: (plainText: string) => Promise<void> },
): Promise<Reply> {
  // 1. YES/NO settles a pending delete. Anything else clears that prompt.
  // 2. Equipment cards are local for add, show, and list. Grok runs only for
  //    "extract equipment from note N" or "extract equipment from document N".
  // 3. Multi-task: a structured list is created locally. A plural cue without a clear
  //    list ("Create tasks:" plus prose) goes to Grok's multi_task_request schema.
  // 4. parseLocalIntent runs next. A confident match is executed with no Grok classification.
  //    "Create a task …" stays on this single-task path.
  // 5. A question that is not a local command searches notes, knowledge, and documents.
  //    Good chunks are passed to Grok as the only context. No chunks, or a web/X
  //    question, continues on the existing path.
  // 6. If the message needs web, X, hosted code execution, or a custom data tool,
  //    runGrokAgent calls Grok with those tools. Custom tools run here, then their
  //    results go back to Grok. Built-in tools run on xAI's servers.
  // 7. Other wording goes to Grok for classification: reports, English rewrites,
  //    and anything the parser and tool selector missed.
  // 8. search_web reads notes, knowledge, and document text before it allows the web.
  try {
    const cleaned = text.trim().slice(0, 8000);
    const now = deps.clock.now().setZone(user.timezone || deps.env.APP_TIMEZONE);
    const pending = await deps.db.getConfirmation(user.id);
    if (/^(yes|confirm)$/i.test(cleaned)) {
      if (!pending) return { text: "There is nothing waiting for confirmation." };
      if (Date.parse(pending.expiresAt) < now.toMillis()) {
        await deps.db.clearConfirmation(user.id);
        return { text: "That confirmation expired. Ask me again if you still want to do it." };
      }
      await deps.db.clearConfirmation(user.id);
      const reply = await execute(deps, user, pending.action, { confirmed: true, onAnalysisPreview: options?.onAnalysisPreview });
      await remember(deps, user, cleaned, reply.text);
      return reply;
    }
    if (pending && /^(no|cancel)$/i.test(cleaned)) {
      await deps.db.clearConfirmation(user.id);
      return { text: "Okay. I left it unchanged." };
    }
    if (pending) await deps.db.clearConfirmation(user.id);
    const noteLink = parseNoteLinkCommand(cleaned);
    if (noteLink) {
      deps.logger.info({ event: "message_route", route: "local_intent" }, "local_intent");
      const reply = { text: noteLink === "clarify"
        ? "Which note, and which task or document? For example: Link note 2 to task 14."
        : await linkNoteCommand(deps, user, noteLink) };
      await remember(deps, user, cleaned, reply.text);
      return reply;
    }
    const equipment = parseEquipmentCommand(cleaned);
    if (equipment) {
      deps.logger.info({ event: "message_route", route: "local_intent" }, "local_intent");
      const reply = await handleEquipment(deps, user, equipment);
      await remember(deps, user, cleaned, reply.text);
      return reply;
    }
    const localReminders = extractLocalReminders(cleaned);
    if (localReminders.kind === "reminders") {
      deps.logger.info({ event: "message_route", route: "local_intent" }, "local_intent");
      deps.logger.info(
        { event: "intent_route", route: "local", intent: "create_reminders", count: localReminders.reminders.length },
        "reminders created locally",
      );
      const reply = await createManyReminders(deps, user, localReminders.reminders);
      await remember(deps, user, cleaned, reply.text);
      return reply;
    }
    if (localReminders.kind === "cue") {
      if (!deps.llm) {
        return { text: "Send those as a list, one reminder per line, or separated by commas. Include a time for each, such as 3 PM or tomorrow." };
      }
      deps.logger.info({ event: "message_route", route: "fallback_grok" }, "fallback_grok");
      deps.logger.info({ event: "intent_route", route: "grok", intent: "create_reminders" }, "message sent to Grok");
      const reminders = await extractRemindersWithGrok(deps, user, cleaned);
      const reply = reminders
        ? await createManyReminders(deps, user, reminders)
        : { text: "I couldn't find separate reminders in that message. Send one reminder per line." };
      await remember(deps, user, cleaned, reply.text);
      return reply;
    }
    const localTasks = extractLocalTasks(cleaned);
    if (localTasks.kind === "tasks") {
      deps.logger.info({ event: "message_route", route: "local_intent" }, "local_intent");
      deps.logger.info(
        { event: "intent_route", route: "local", intent: "create_tasks", count: localTasks.tasks.length },
        "message handled locally",
      );
      const reply = await createManyTasks(deps, user, localTasks.tasks);
      await remember(deps, user, cleaned, reply.text);
      return reply;
    }
    if (localTasks.kind === "cue") {
      if (!deps.llm) {
        return { text: "Send those as a list, one task per line, or separated by commas." };
      }
      deps.logger.info({ event: "message_route", route: "fallback_grok" }, "fallback_grok");
      deps.logger.info({ event: "intent_route", route: "grok", intent: "create_tasks" }, "message sent to Grok");
      const tasks = await extractTasksWithGrok(deps, user, cleaned);
      const reply = tasks
        ? await createManyTasks(deps, user, tasks)
        : { text: "I couldn't find separate tasks in that message. Send one title per line." };
      await remember(deps, user, cleaned, reply.text);
      return reply;
    }
    const local = parseLocalIntent(cleaned);
    const toolKinds = isConfidentLocalIntent(local) ? [] : toolsForMessage(cleaned);
    const wantsWeb = toolKinds.includes("web_search") || toolKinds.includes("x_search");
    if (isConfidentLocalIntent(local)) {
      deps.logger.info({ event: "message_route", route: "local_intent" }, "local_intent");
    } else if (!wantsWeb && looksLikeQuestion(cleaned)) {
      const grounded = await answerWithRag(deps, user, cleaned, options?.onAnalysisPreview);
      if (grounded) {
        await remember(deps, user, cleaned, grounded.text);
        return grounded;
      }
      deps.logger.info({ event: "message_route", route: "fallback_grok" }, "fallback_grok");
    } else {
      deps.logger.info({ event: "message_route", route: "fallback_grok" }, "fallback_grok");
    }
    if (toolKinds.length > 0 && deps.llm?.completeWithTools) {
      deps.logger.info({ event: "intent_route", route: "grok", intent: "agent", tools: toolKinds }, "message sent to Grok");
      const reply = await runGrokAgent(deps, user, cleaned, toolKinds, options?.onAnalysisPreview);
      await remember(deps, user, cleaned, reply.text);
      return reply;
    }
    const intent = await interpret(deps, user, cleaned);
    const reply = await execute(deps, user, intent, { confirmed: false, onAnalysisPreview: options?.onAnalysisPreview });
    if (reply.confirmation) {
      const expires = now.plus({ minutes: 10 }).toUTC().toISO();
      if (expires) await deps.db.putConfirmation(user.id, reply.confirmation, expires);
    }
    await remember(deps, user, cleaned, reply.text);
    return reply;
  } catch (error) {
    deps.logger.error({ event: "message_failed", message: redactString(error instanceof Error ? error.message : "error") }, "message failed");
    return { text: toUserMessage(error) };
  }
}
