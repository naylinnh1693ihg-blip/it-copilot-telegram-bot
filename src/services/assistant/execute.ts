import { DateTime } from "luxon";
import type { Deps } from "../../app/deps.js";
import type { Intent } from "../../types/intent.js";
import type { Note, Reminder, Task, User } from "../../types/models.js";
import { matchCategory } from "../knowledge/categories.js";
import { documentLink } from "../documents/documentService.js";
import { SIGNED_URL_SECONDS } from "../documents/storage.js";
import { englishPrompt, explainPrompt, polishPrompt, summaryPrompt } from "../grok/prompts.js";
import { parseSchedule, reminderDedupeKey } from "../reminders/schedule.js";
import { introducedNetworkFacts } from "../../utils/security.js";
import { cleanText, disruptiveWarning, parseTags, secretRisk, snippet } from "../../utils/text.js";
import { formatWhen, parseClock, toIso } from "../../utils/time.js";
import { HELP_TEXT } from "./help.js";
import { draftDailySummary, draftIncidentReport, draftShiftHandover } from "./reports.js";

export interface Reply {
  text: string;
  keyboard?: "menu" | "confirm";
  confirmation?: Intent;
}

function zoneNow(deps: Deps, user: User): DateTime {
  return deps.clock.now().setZone(user.timezone || deps.env.APP_TIMEZONE);
}

async function audit(
  deps: Deps,
  user: User,
  action: string,
  entity: string,
  entityId: string | null,
  metadata: Record<string, string | number | boolean | null>,
): Promise<void> {
  try {
    await deps.db.writeAudit({
      userId: user.id,
      action,
      entity,
      entityId,
      metadata,
      createdAt: toIso(deps.clock.now()),
    });
  } catch (error) {
    deps.logger.warn({ event: "audit_failed", message: error instanceof Error ? error.message : "audit failed" }, "audit failed");
  }
}

function taskLine(task: Task, zone: string): string {
  return `${task.taskNumber}. [${task.priority}] ${task.title}\n   ${task.status}, due ${formatWhen(task.dueAt, zone)}`;
}

function openTasks(tasks: Task[]): Task[] {
  return tasks.filter((task) => task.status === "pending" || task.status === "in_progress");
}

function filterTasks(tasks: Task[], filter: Intent["list_filter"], now: DateTime): Task[] {
  const open = openTasks(tasks);
  if (filter === "overdue") {
    return open.filter((task) => task.dueAt && DateTime.fromISO(task.dueAt) < now);
  }
  if (filter === "today") {
    return open.filter((task) => task.dueAt && DateTime.fromISO(task.dueAt).setZone(now.zone).hasSame(now, "day"));
  }
  return open;
}

async function guardedText(deps: Deps, user: User, purpose: string, prompt: { system: string; user: string }, source: string): Promise<string | null> {
  if (!deps.llm) return null;
  const result = await deps.llm.completeText(prompt);
  await deps.db.recordUsage({
    userId: user.id,
    model: deps.env.XAI_MODEL,
    purpose,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    estimatedUsd:
      (result.inputTokens / 1_000_000) * deps.env.XAI_INPUT_USD_PER_MILLION +
      (result.outputTokens / 1_000_000) * deps.env.XAI_OUTPUT_USD_PER_MILLION,
    createdAt: toIso(deps.clock.now()),
  }).catch(() => undefined);
  if (introducedNetworkFacts(source, result.text).length > 0) return null;
  return result.text.trim();
}

export async function execute(deps: Deps, user: User, intent: Intent, options: { confirmed: boolean }): Promise<Reply> {
  const now = zoneNow(deps, user);
  const zone = now.zoneName ?? user.timezone;

  switch (intent.intent) {
    case "help":
      return { text: HELP_TEXT, keyboard: "menu" };
    case "clarify":
      return { text: intent.clarification_question || "Can you say that in a shorter way?" };
    case "create_task": {
      const title = cleanText(intent.title || intent.details, 200);
      if (!title) return { text: "What should the task be called?" };
      let dueAt: string | null = null;
      if (intent.when_text) {
        const schedule = parseSchedule(intent.when_text, now);
        if (!schedule) return { text: "I couldn't read that due time. Try 'tomorrow' or '3 PM'." };
        dueAt = toIso(schedule.at);
      }
      const task = await deps.db.insertTask({
        userId: user.id,
        title,
        description: cleanText(intent.details, 4000),
        category: matchCategory(`${intent.category} ${title}`),
        priority: intent.priority || "normal",
        status: "pending",
        dueAt,
        tags: parseTags(intent.tags),
        createdAt: toIso(now),
      });
      await deps.db.addTaskEvent({ taskId: task.id, userId: user.id, action: "created", summary: title, createdAt: task.createdAt });
      await audit(deps, user, "task.create", "task", task.id, { taskNumber: task.taskNumber });
      return { text: `Created task ${task.taskNumber}: ${task.title}. Priority ${task.priority}. Due ${formatWhen(task.dueAt, zone)}.` };
    }
    case "list_tasks": {
      if (intent.tags === "history" && intent.entity_number) {
        const events = await deps.db.listTaskEvents(user.id, intent.entity_number);
        if (events.length === 0) return { text: `I don't have any history for task ${intent.entity_number}.` };
        return { text: events.map((event) => `${formatWhen(event.createdAt, zone)} — ${event.action}: ${event.summary}`).join("\n") };
      }
      const tasks = filterTasks(await deps.db.listTasks(user.id), intent.list_filter, now);
      if (tasks.length === 0) {
        const label = intent.list_filter === "today" ? "today" : intent.list_filter === "overdue" ? "overdue" : "pending";
        return { text: `You have no ${label} tasks.` };
      }
      return { text: tasks.map((task) => taskLine(task, zone)).join("\n\n") };
    }
    case "complete_task":
    case "delete_task":
    case "update_task": {
      if (!intent.entity_number) return { text: "Which task number should I change?" };
      const task = await deps.db.findTask(user.id, intent.entity_number);
      if (!task || task.deletedAt) return { text: `I don't have task ${intent.entity_number}.` };
      if (intent.intent === "delete_task" && !options.confirmed) {
        return {
          text: `Delete task ${task.taskNumber}: ${task.title}?\nReply YES to delete it, or NO to keep it.`,
          keyboard: "confirm",
          confirmation: intent,
        };
      }
      const updated: Task = { ...task, updatedAt: toIso(now) };
      let action = "updated";
      if (intent.intent === "complete_task") {
        updated.status = "completed";
        updated.completedAt = toIso(now);
        action = "completed";
      } else if (intent.intent === "delete_task") {
        updated.deletedAt = toIso(now);
        updated.status = "cancelled";
        action = "deleted";
      } else if (intent.status === "in_progress") {
        updated.status = "in_progress";
      } else if (intent.when_text === "tomorrow") {
        const previous = task.dueAt ? DateTime.fromISO(task.dueAt).setZone(zone) : null;
        const moved = now.plus({ days: 1 }).set({
          hour: previous?.hour ?? 9,
          minute: previous?.minute ?? 0,
          second: 0,
          millisecond: 0,
        });
        updated.dueAt = toIso(moved);
        action = "rescheduled";
      } else if (intent.title) {
        updated.title = cleanText(intent.title, 200);
      }
      const saved = await deps.db.updateTask(updated);
      await deps.db.addTaskEvent({ taskId: saved.id, userId: user.id, action, summary: saved.title, createdAt: saved.updatedAt });
      await audit(deps, user, `task.${action}`, "task", saved.id, { taskNumber: saved.taskNumber });
      if (action === "deleted") return { text: `Deleted task ${saved.taskNumber}. It stays in history and its number will not be reused.` };
      if (action === "completed") return { text: `Completed task ${saved.taskNumber}: ${saved.title}.` };
      return { text: `Updated task ${saved.taskNumber}: ${saved.title}. Due ${formatWhen(saved.dueAt, zone)}.` };
    }
    case "create_reminder": {
      const message = cleanText(intent.details || intent.title, 500);
      if (!message) return { text: "What should I remind you about?" };
      let schedule = parseSchedule(intent.when_text, now);
      if (intent.recurrence === "daily_summary") {
        const clock = parseClock(intent.when_text);
        if (!clock) return { text: "What time should I send the daily summary? For example: 8 AM." };
        schedule = parseSchedule(`every day at ${intent.when_text}`, now);
      }
      if (intent.recurrence === "interval" && intent.interval_minutes > 0) {
        schedule = {
          kind: "interval",
          at: now.plus({ minutes: intent.interval_minutes }),
          weekdays: [],
          intervalMinutes: intent.interval_minutes,
        };
      }
      if (!schedule) return { text: "I couldn't read that reminder time. Try 'tomorrow at 9 AM' or 'in 30 minutes'." };
      const kind = intent.recurrence === "daily_summary" ? "daily_summary" : schedule.kind;
      const result = await deps.db.insertReminder({
        userId: user.id,
        title: cleanText(intent.title || message, 160),
        message,
        kind,
        timezone: zone,
        nextRunAt: toIso(schedule.at),
        weekdays: schedule.weekdays,
        intervalMinutes: schedule.intervalMinutes,
        status: "active",
        dedupeKey: reminderDedupeKey({
          kind,
          title: intent.title || message,
          at: schedule.at,
          weekday: schedule.weekdays[0] ?? null,
        }),
        createdAt: toIso(now),
      });
      if (kind === "daily_summary") await deps.db.setDailySummaryTime(user.id, schedule.at.toFormat("HH:mm"), toIso(now));
      await audit(deps, user, "reminder.create", "reminder", result.reminder.id, { reminderNumber: result.reminder.reminderNumber });
      const prefix = result.created ? "Scheduled reminder" : "That reminder is already scheduled as";
      return { text: `${prefix} ${result.reminder.reminderNumber}: ${result.reminder.title}. Next: ${formatWhen(result.reminder.nextRunAt, zone)}.` };
    }
    case "list_reminders": {
      const reminders = (await deps.db.listReminders(user.id)).filter((reminder) => reminder.status === "active");
      if (reminders.length === 0) return { text: "You have no active reminders." };
      return {
        text: reminders
          .map((reminder) => `${reminder.reminderNumber}. ${reminder.title}\n   ${reminder.kind}, next ${formatWhen(reminder.nextRunAt, zone)}`)
          .join("\n\n"),
      };
    }
    case "cancel_reminder": {
      const query = intent.search_query.toLowerCase();
      const matches = (await deps.db.listReminders(user.id)).filter(
        (reminder) => reminder.status === "active" && `${reminder.title} ${reminder.message}`.toLowerCase().includes(query),
      );
      if (matches.length === 0) return { text: `I don't have an active reminder about "${intent.search_query}".` };
      if (matches.length > 1) {
        return { text: `I found more than one reminder. Reply with a number:\n${matches.map((item) => `${item.reminderNumber}. ${item.title}`).join("\n")}` };
      }
      const reminder = matches[0];
      if (!reminder) return { text: "I couldn't load that reminder." };
      if (!options.confirmed) {
        return {
          text: `Cancel reminder ${reminder.reminderNumber}: ${reminder.title}?\nReply YES to cancel it, or NO to keep it.`,
          keyboard: "confirm",
          confirmation: { ...intent, entity_number: reminder.reminderNumber },
        };
      }
      const target = intent.entity_number ? await deps.db.findReminder(user.id, intent.entity_number) : reminder;
      if (!target) return { text: "That reminder is no longer available." };
      const saved = await deps.db.updateReminder({ ...target, status: "cancelled", lockedUntil: null, lockToken: null, updatedAt: toIso(now) });
      await audit(deps, user, "reminder.cancel", "reminder", saved.id, { reminderNumber: saved.reminderNumber });
      return { text: `Cancelled reminder ${saved.reminderNumber}: ${saved.title}.` };
    }
    case "snooze_reminder": {
      if (!user.lastNotifiedReminderId) return { text: "I don't have a current reminder to snooze." };
      const reminders = await deps.db.listReminders(user.id);
      const reminder = reminders.find((item) => item.id === user.lastNotifiedReminderId);
      if (!reminder) return { text: "I don't have a current reminder to snooze." };
      const minutes = intent.snooze_minutes || 15;
      const saved = await deps.db.updateReminder({
        ...reminder,
        status: "active",
        nextRunAt: toIso(now.plus({ minutes })),
        attemptOccurrenceAt: null,
        lockedUntil: null,
        lockToken: null,
        lastError: null,
        updatedAt: toIso(now),
      });
      return { text: `Snoozed reminder ${saved.reminderNumber} until ${formatWhen(saved.nextRunAt, zone)}.` };
    }
    case "save_note":
    case "save_knowledge": {
      const content = cleanText(intent.details, 8000);
      if (!content) return { text: "What should I save?" };
      const risk = secretRisk(content);
      if (risk) {
        return { text: `I didn't save that. It looks like a ${risk}. Keep passwords, keys, and tokens in a password manager, not in this copilot.` };
      }
      const category = intent.category ? matchCategory(intent.category) : matchCategory(content);
      const warning = disruptiveWarning(content);
      if (intent.intent === "save_note") {
        const note = await deps.db.insertNote({
          userId: user.id,
          title: cleanText(intent.title || content, 80),
          content,
          category,
          tags: parseTags(intent.tags),
          createdAt: toIso(now),
        });
        await audit(deps, user, "note.create", "note", note.id, { noteNumber: note.noteNumber });
        return { text: `Saved note ${note.noteNumber} in ${note.category}: ${snippet(note.content)}` };
      }
      const entry = await deps.db.insertKnowledge({
        userId: user.id,
        title: cleanText(intent.title || content, 80),
        content,
        category,
        tags: parseTags(intent.tags === "explain" ? "" : intent.tags),
        createdAt: toIso(now),
      });
      await audit(deps, user, "knowledge.create", "knowledge", entry.id, { entryNumber: entry.entryNumber });
      let explanation = "";
      if (intent.tags === "explain") {
        if (warning) explanation = `\n\n${warning}`;
        else if (!deps.llm) explanation = "\n\nI saved it. An explanation needs XAI_API_KEY.";
        else {
          const text = await guardedText(deps, user, "explain", explainPrompt(content, false), content);
          explanation = text ? `\n\n${text}` : "\n\nI saved it, but I discarded the explanation because it added details that were not in your command.";
        }
      }
      return { text: `Saved knowledge ${entry.entryNumber} under ${entry.category}: ${snippet(entry.content)}${warning && intent.tags !== "explain" ? `\n\n${warning}` : ""}${explanation}` };
    }
    case "search_notes":
    case "search_knowledge": {
      const query = cleanText(intent.search_query, 200);
      if (!query) return { text: "What should I search for?" };
      const notes = await deps.db.searchNotes(user.id, query);
      const knowledge = await deps.db.searchKnowledge(user.id, query);
      if (notes.length === 0 && knowledge.length === 0) return { text: `I don't have anything saved about "${query}".` };
      const lines = [
        ...notes.map((note) => `Note ${note.noteNumber}: ${snippet(note.content)}`),
        ...knowledge.map((entry) => `Knowledge ${entry.entryNumber} (${entry.category}): ${snippet(entry.content)}`),
      ];
      if (intent.tags === "summarize" && deps.llm) {
        const summary = await guardedText(deps, user, "summarize_records", summaryPrompt(lines.join("\n")), lines.join("\n"));
        if (summary) return { text: `${summary}\n\nSources:\n${lines.join("\n")}` };
      }
      return { text: lines.join("\n") };
    }
    case "update_note": {
      const matches = await deps.db.searchNotes(user.id, intent.search_query);
      if (matches.length === 0) return { text: `I don't have a note about "${intent.search_query}".` };
      if (matches.length > 1) {
        return { text: `I found more than one note. Tell me the number:\n${matches.map((note) => `${note.noteNumber}. ${snippet(note.title)}`).join("\n")}` };
      }
      const note = matches[0];
      if (!note) return { text: "I couldn't load that note." };
      const addition = cleanText(intent.details, 4000);
      const risk = secretRisk(addition);
      if (risk) return { text: `I didn't change the note. The new text looks like a ${risk}.` };
      const saved = await deps.db.updateNote({
        ...note,
        content: `${note.content}\n\nUpdated ${now.toFormat("d LLL yyyy")}: ${addition}`,
        updatedAt: toIso(now),
      });
      return { text: `Updated note ${saved.noteNumber}. I kept the older text and added your new paragraph.` };
    }
    case "delete_note": {
      const note = await deps.db.findNote(user.id, intent.entity_number);
      if (!note || note.deletedAt) return { text: `I don't have note ${intent.entity_number}.` };
      if (!options.confirmed) {
        return {
          text: `Delete note ${note.noteNumber}: ${snippet(note.title)}?\nReply YES to delete it, or NO to keep it.`,
          keyboard: "confirm",
          confirmation: intent,
        };
      }
      await deps.db.updateNote({ ...note, deletedAt: toIso(now), updatedAt: toIso(now) });
      await audit(deps, user, "note.delete", "note", note.id, { noteNumber: note.noteNumber });
      return { text: `Deleted note ${note.noteNumber}.` };
    }
    case "search_documents":
    case "send_document":
    case "summarize_document": {
      const documents = intent.entity_number
        ? [await deps.db.findDocument(user.id, intent.entity_number)].filter((item): item is NonNullable<typeof item> => !!item)
        : intent.search_query
          ? await deps.db.searchDocuments(user.id, intent.search_query)
          : await deps.db.listDocuments(user.id);
      if (documents.length === 0) return { text: intent.search_query ? `I don't have a saved document about "${intent.search_query}".` : "You have no saved documents." };
      if (intent.intent === "search_documents") {
        return { text: documents.map((document) => `${document.documentNumber}. ${document.title} (${document.category})`).join("\n") };
      }
      const document = documents[0];
      if (!document) return { text: "I couldn't load that document." };
      if (intent.intent === "send_document") {
        if (documents.length > 1) {
          return { text: `I found more than one file. Tell me the number:\n${documents.map((item) => `${item.documentNumber}. ${item.title}`).join("\n")}` };
        }
        const linked = await documentLink(deps, user, document.documentNumber);
        return { text: `Document ${linked.document.documentNumber}: ${linked.document.title}\n${linked.url}\nThis link expires in ${SIGNED_URL_SECONDS / 60} minutes.` };
      }
      const extraction = await deps.db.getExtraction(document.id);
      if (!extraction?.text) return { text: `I stored document ${document.documentNumber}, but it has no extracted text to summarize.` };
      if (!deps.llm) return { text: `A written summary needs XAI_API_KEY. Excerpt from document ${document.documentNumber}:\n${snippet(extraction.text, 800)}` };
      const summary = await guardedText(deps, user, "summarize_document", summaryPrompt(extraction.text), extraction.text);
      if (!summary) return { text: `I couldn't safely summarize document ${document.documentNumber} because the draft added details that are not in the file.` };
      return { text: `Summary of document ${document.documentNumber}:\n${summary}` };
    }
    case "save_document":
      return { text: "Attach the file in this private chat. You can add a caption such as 'Save this as Cisco network documentation.'" };
    case "prepare_incident_report": {
      const draft = draftIncidentReport(intent.details);
      const polished = await guardedText(deps, user, "incident_report", polishPrompt(draft.text), draft.text);
      return { text: polished ?? draft.text };
    }
    case "prepare_shift_handover": {
      const tasks = openTasks(await deps.db.listTasks(user.id)).map((task) => taskLine(task, zone));
      const draft = draftShiftHandover(intent.details, tasks);
      const polished = await guardedText(deps, user, "handover", polishPrompt(draft.text), `${draft.text}\n${tasks.join("\n")}`);
      return { text: polished ?? draft.text };
    }
    case "generate_daily_summary":
      return { text: await summaryFromRecords(deps, user, now) };
    case "improve_english": {
      if (!intent.details.trim()) return { text: "Paste the English you want me to improve." };
      if (!deps.llm) return { text: "Rewriting English needs XAI_API_KEY. I did not change your text." };
      const rewritten = await guardedText(deps, user, "english", englishPrompt(intent.details), intent.details);
      if (!rewritten) return { text: "I didn't rewrite that because the draft added details that were not in your text." };
      return { text: `Clearer version:\n${rewritten}` };
    }
    default:
      return { text: "I can't do that action." };
  }
}

export async function summaryFromRecords(deps: Deps, user: User, now: DateTime): Promise<string> {
  const zone = now.zoneName ?? user.timezone;
  const tasks = await deps.db.listTasks(user.id);
  const overdue = filterTasks(tasks, "overdue", now).map((task) => taskLine(task, zone));
  const dueToday = filterTasks(tasks, "today", now).map((task) => taskLine(task, zone));
  const pending = openTasks(tasks)
    .filter((task) => !dueToday.some((line) => line.startsWith(`${task.taskNumber}.`)) && !overdue.some((line) => line.startsWith(`${task.taskNumber}.`)))
    .map((task) => taskLine(task, zone));
  const reminders = (await deps.db.listReminders(user.id))
    .filter((reminder) => reminder.status === "active")
    .slice(0, 10)
    .map((reminder: Reminder) => `${reminder.reminderNumber}. ${reminder.title} at ${formatWhen(reminder.nextRunAt, zone)}`);
  return draftDailySummary({ dateLabel: now.toFormat("cccc d LLLL yyyy"), overdue, dueToday, pending, reminders });
}

export function noteSnippet(note: Note): string {
  return snippet(note.content);
}
