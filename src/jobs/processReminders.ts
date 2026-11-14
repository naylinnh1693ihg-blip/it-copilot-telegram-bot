import { DateTime } from "luxon";
import type { Deps } from "../app/deps.js";
import type { Reminder, User } from "../types/models.js";
import { summaryFromRecords } from "../services/assistant/execute.js";
import { reminderButtons, type ReminderButton } from "../services/reminders/buttons.js";
import { nextOccurrenceAfter } from "../services/reminders/schedule.js";
import { redactString } from "../utils/text.js";
import { toIso } from "../utils/time.js";

const MAX_ATTEMPTS = 5;

export interface ReminderRun {
  sent: number;
  failed: number;
  skipped: number;
}

async function save(deps: Deps, reminder: Reminder): Promise<void> {
  await deps.db.updateReminder(reminder);
}

function backoff(attempt: number, now: DateTime): string {
  const minutes = Math.min(2 ** Math.max(attempt - 1, 0), 60);
  return toIso(now.plus({ minutes }));
}

export async function processDueReminders(
  deps: Deps,
  options: {
    workerId: string;
    /** Which trigger ran this batch, for the "reminder_cron_run" log line. */
    source?: "http" | "poll";
    limit?: number;
    lockSeconds?: number;
    /** chatId is the user's id for a private reminder, or the team group's id. threadId is the forum topic. */
    send: (chatId: number, text: string, buttons?: ReminderButton[], options?: { threadId?: number }) => Promise<{ messageId: number }>;
  },
): Promise<ReminderRun> {
  const now = deps.clock.now();
  const nowIso = toIso(now);
  const claimed = await deps.db.claimDueReminders(options.workerId, options.limit ?? 20, options.lockSeconds ?? 120, nowIso);
  const result: ReminderRun = { sent: 0, failed: 0, skipped: 0 };

  for (const claimedReminder of claimed) {
    const user = await deps.db.findUserById(claimedReminder.userId);
    const occurrence = claimedReminder.attemptOccurrenceAt ?? claimedReminder.nextRunAt;
    const reminder: Reminder = claimedReminder.attemptOccurrenceAt
      ? claimedReminder
      : { ...claimedReminder, attemptOccurrenceAt: occurrence };
    if (!claimedReminder.attemptOccurrenceAt) await save(deps, reminder);

    const gate = await deps.db.startDelivery(reminder.id, occurrence, nowIso);
    if (gate.action === "skip") {
      await advance(deps, reminder, occurrence);
      result.skipped += 1;
      continue;
    }

    // A team-group reminder goes back to the group, which the bot can always post to.
    // A private one needs the user to have started the bot.
    const toGroup = reminder.deliveryChatId !== null;
    if (!user || (!toGroup && !user.startedBot)) {
      const message = "The user has not started the bot.";
      await deps.db.finishDelivery(reminder.id, occurrence, "failed", message, null, nowIso);
      await fail(deps, reminder, user, occurrence, gate.attempt, message, now);
      result.failed += 1;
      continue;
    }

    try {
      const text = reminder.kind === "daily_summary" ? await summaryFromRecords(deps, user, now.setZone(reminder.timezone)) : `Reminder: ${reminder.message}`;
      const sent = toGroup
        ? await options.send(reminder.deliveryChatId as number, text, reminderButtons(reminder.id), reminder.deliveryThreadId ? { threadId: reminder.deliveryThreadId } : undefined)
        : await options.send(user.telegramUserId, text, reminderButtons(reminder.id));
      await deps.db.finishDelivery(reminder.id, occurrence, "sent", null, sent.messageId, nowIso);
      await deps.db.setLastNotifiedReminder(user.id, reminder.id, nowIso);
      await advance(deps, reminder, occurrence);
      result.sent += 1;
    } catch (error) {
      const message = redactString(error instanceof Error ? error.message : "Delivery failed");
      await deps.db.finishDelivery(reminder.id, occurrence, "failed", message, null, nowIso);
      await fail(deps, reminder, user, occurrence, gate.attempt, message, now);
      result.failed += 1;
    }
  }
  // One line per run, so the logs show which trigger (Supabase cron or the in-process poll)
  // is working. Counts only.
  deps.logger.info({ event: "reminder_cron_run", source: options.source ?? "poll", ...result }, "reminder run finished");
  return result;
}

/**
 * The next regular run after this occurrence. A pending snooze keeps the schedule it interrupted.
 * Either way, times that have already passed are skipped so missed runs are not sent back to back.
 */
function nextScheduledRun(reminder: Reminder, occurrence: string, nowIso: string): string | null {
  const base = reminder.snoozedNextRunAt ?? occurrence;
  return nextOccurrenceAfter(reminder.kind, base, reminder.timezone, reminder.intervalMinutes, nowIso);
}

async function advance(deps: Deps, reminder: Reminder, occurrence: string): Promise<void> {
  const nowIso = toIso(deps.clock.now());
  const next = nextScheduledRun(reminder, occurrence, nowIso);
  await save(deps, {
    ...reminder,
    status: next ? "active" : "completed",
    nextRunAt: next ?? occurrence,
    attemptOccurrenceAt: null,
    snoozedNextRunAt: null,
    lockedUntil: null,
    lockToken: null,
    lastError: null,
    updatedAt: nowIso,
  });
}

async function fail(
  deps: Deps,
  reminder: Reminder,
  _user: User | null,
  occurrence: string,
  attempt: number,
  message: string,
  now: DateTime,
): Promise<void> {
  if (attempt >= MAX_ATTEMPTS) {
    const next = nextScheduledRun(reminder, occurrence, toIso(now));
    await save(deps, {
      ...reminder,
      status: next ? "active" : "failed",
      nextRunAt: next ?? toIso(now.plus({ hours: 1 })),
      attemptOccurrenceAt: null,
      snoozedNextRunAt: null,
      lockedUntil: null,
      lockToken: null,
      lastError: message,
      updatedAt: toIso(now),
    });
    return;
  }
  await save(deps, {
    ...reminder,
    status: "active",
    nextRunAt: backoff(attempt, now),
    attemptOccurrenceAt: occurrence,
    lockedUntil: null,
    lockToken: null,
    lastError: message,
    updatedAt: toIso(now),
  });
}
