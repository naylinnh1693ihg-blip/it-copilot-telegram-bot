import { DateTime } from "luxon";
import type { Deps } from "../app/deps.js";
import type { Reminder, User } from "../types/models.js";
import { summaryFromRecords } from "../services/assistant/execute.js";
import { reminderButtons, type ReminderButton } from "../services/reminders/buttons.js";
import { advanceOccurrence } from "../services/reminders/schedule.js";
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
    limit?: number;
    lockSeconds?: number;
    send: (telegramUserId: number, text: string, buttons?: ReminderButton[]) => Promise<{ messageId: number }>;
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

    if (!user?.startedBot) {
      const message = "The user has not started the bot.";
      await deps.db.finishDelivery(reminder.id, occurrence, "failed", message, null, nowIso);
      await fail(deps, reminder, user, occurrence, gate.attempt, message, now);
      result.failed += 1;
      continue;
    }

    try {
      const text = reminder.kind === "daily_summary" ? await summaryFromRecords(deps, user, now.setZone(reminder.timezone)) : `Reminder: ${reminder.message}`;
      const sent = await options.send(user.telegramUserId, text, reminderButtons(reminder.id));
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
  return result;
}

async function advance(deps: Deps, reminder: Reminder, occurrence: string): Promise<void> {
  if (reminder.snoozedNextRunAt) {
    await save(deps, {
      ...reminder,
      status: "active",
      nextRunAt: reminder.snoozedNextRunAt,
      attemptOccurrenceAt: null,
      snoozedNextRunAt: null,
      lockedUntil: null,
      lockToken: null,
      lastError: null,
      updatedAt: toIso(deps.clock.now()),
    });
    return;
  }
  const next = advanceOccurrence(reminder.kind, occurrence, reminder.timezone, reminder.intervalMinutes);
  await save(deps, {
    ...reminder,
    status: next ? "active" : "completed",
    nextRunAt: next ?? occurrence,
    attemptOccurrenceAt: null,
    lockedUntil: null,
    lockToken: null,
    lastError: null,
    updatedAt: toIso(deps.clock.now()),
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
    if (reminder.snoozedNextRunAt) {
      await save(deps, {
        ...reminder,
        status: "active",
        nextRunAt: reminder.snoozedNextRunAt,
        attemptOccurrenceAt: null,
        snoozedNextRunAt: null,
        lockedUntil: null,
        lockToken: null,
        lastError: message,
        updatedAt: toIso(now),
      });
      return;
    }
    const next = reminder.kind === "once" ? null : advanceOccurrence(reminder.kind, occurrence, reminder.timezone, reminder.intervalMinutes);
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
