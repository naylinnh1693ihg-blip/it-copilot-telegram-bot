import type { Deps } from "../../app/deps.js";
import type { Reminder, User } from "../../types/models.js";
import { formatWhen, toIso } from "../../utils/time.js";

export const REMINDER_SNOOZE_MINUTES = 60;

export interface ReminderButton {
  label: string;
  data: string;
}

export function reminderButtons(reminderId: string): ReminderButton[] {
  return [
    { label: "Done", data: `r:done:${reminderId}` },
    { label: "Snooze 1h", data: `r:snooze:${reminderId}` },
  ];
}

export function parseReminderCallback(data: string): { action: "done" | "snooze"; reminderId: string } | null {
  const match = /^r:(done|snooze):([0-9a-f-]{36})$/i.exec(data.trim());
  const action = match?.[1];
  const reminderId = match?.[2];
  if (action !== "done" && action !== "snooze") return null;
  if (!reminderId) return null;
  return { action, reminderId };
}

export interface ReminderButtonResult {
  /** Short toast. Telegram shows this only if the callback is answered with text. */
  toast: string;
  /** Replacement for the original reminder message. Null when the record should be left as it is. */
  editText: string | null;
  text: string;
}

export async function applyReminderButton(
  deps: Deps,
  user: User,
  action: "done" | "snooze",
  reminderId: string,
): Promise<ReminderButtonResult> {
  const reminder = await deps.db.findReminderById(reminderId);
  const owned = reminder !== null && reminder.userId === user.id;
  if (!owned || reminder.status === "cancelled") {
    deps.logger.info({ event: "reminder_button", action: "ignored", reminderId }, "reminder button ignored");
    return { toast: "That reminder is no longer available.", editText: null, text: "That reminder is no longer available." };
  }
  const now = deps.clock.now().setZone(user.timezone || reminder.timezone);
  if (action === "done") {
    if (reminder.status !== "completed") {
      await save(deps, { ...reminder, status: "completed", attemptOccurrenceAt: null, lockedUntil: null, lockToken: null, lastError: null, updatedAt: toIso(now) });
    }
    deps.logger.info({ event: "reminder_button", action: "done", reminderId }, "reminder marked done");
    const text = `Done. Reminder ${reminder.reminderNumber}: ${reminder.title}`;
    return { toast: "Marked done", editText: `${reminderText(reminder)}\n\nDone.`, text };
  }
  const nextRunAt = toIso(now.plus({ minutes: REMINDER_SNOOZE_MINUTES }));
  const saved = await save(deps, {
    ...reminder,
    status: "active",
    nextRunAt,
    attemptOccurrenceAt: null,
    lockedUntil: null,
    lockToken: null,
    lastError: null,
    updatedAt: toIso(now),
  });
  deps.logger.info({ event: "reminder_button", action: "snoozed", reminderId }, "reminder snoozed");
  const when = formatWhen(saved.nextRunAt, user.timezone || reminder.timezone);
  const text = `Snoozed reminder ${saved.reminderNumber} until ${when}.`;
  return { toast: "Snoozed 1 hour", editText: `${reminderText(reminder)}\n\nSnoozed until ${when}.`, text };
}

function reminderText(reminder: Reminder): string {
  return reminder.kind === "daily_summary" ? "Daily summary" : `Reminder: ${reminder.message}`;
}

async function save(deps: Deps, reminder: Reminder): Promise<Reminder> {
  return deps.db.updateReminder(reminder);
}
