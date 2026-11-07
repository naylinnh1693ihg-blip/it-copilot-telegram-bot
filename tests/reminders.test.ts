import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { processDueReminders } from "../src/jobs/processReminders.js";
import { applyReminderButton } from "../src/services/reminders/buttons.js";
import { handleText } from "../src/services/assistant/handleText.js";
import { advanceOccurrence } from "../src/services/reminders/schedule.js";
import { fixedClock } from "../src/utils/time.js";
import { NOW, owner, testDeps } from "./helpers.js";

describe("reminders", () => {
  it("schedules one-time, relative, weekly, and daily summary reminders in Asia/Dubai", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    const tomorrow = await handleText(deps, user, "Remind me tomorrow at 9 AM to check the server backup.");
    expect(tomorrow.text).toContain("31 Oct 2026, 9:00 AM");
    const soon = await handleText(deps, user, "Remind me in 30 minutes to call the network team.");
    expect(soon.text).toContain("10:30 AM");
    const weekly = await handleText(deps, user, "Every Monday at 10 AM, remind me to check network incidents.");
    expect(weekly.text).toContain("2 Nov 2026, 10:00 AM");
    const duplicate = await handleText(deps, user, "Every Monday at 10 AM, remind me to check network incidents.");
    expect(duplicate.text).toContain("already scheduled");
    const summary = await handleText(deps, user, "Give me my daily summary at 8 AM.");
    expect(summary.text).toContain("8:00 AM");
    const unclear = await handleText(deps, user, "Remind me 15 minutes before my meeting.");
    expect(unclear.text).toContain("What time is the meeting?");
    expect((await db.listReminders(user.id)).filter((item) => item.status === "active")).toHaveLength(4);
  });

  it("keeps 9 AM local across the America/New_York daylight-saving change", () => {
    const next = advanceOccurrence("daily", "2026-03-07T14:00:00.000Z", "America/New_York", null);
    const local = DateTime.fromISO(next ?? "", { zone: "America/New_York" });
    expect(local.hour).toBe(9);
    expect(local.toFormat("ZZ")).toBe("-04:00");
  });

  it("does not let a second worker claim a locked reminder", async () => {
    const { db } = testDeps();
    const user = await owner(db);
    await db.insertReminder({
      userId: user.id,
      title: "Backup",
      message: "Check backup",
      kind: "once",
      timezone: "Asia/Dubai",
      nextRunAt: "2026-10-30T06:00:00.000Z",
      weekdays: [],
      intervalMinutes: null,
      status: "active",
      dedupeKey: "once|backup|test|",
      createdAt: NOW,
    });
    const first = await db.claimDueReminders("worker-a", 10, 120, "2026-10-30T06:05:00.000Z");
    const second = await db.claimDueReminders("worker-b", 10, 120, "2026-10-30T06:05:00.000Z");
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it("sends once, retries after a failure, and does not send the same occurrence twice", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    await db.insertReminder({
      userId: user.id,
      title: "Call team",
      message: "Call the network team",
      kind: "once",
      timezone: "Asia/Dubai",
      nextRunAt: "2026-10-30T06:00:00.000Z",
      weekdays: [],
      intervalMinutes: null,
      status: "active",
      dedupeKey: "once|call|test|",
      createdAt: NOW,
    });
    let calls = 0;
    let fail = true;
    const mutable = { now: DateTime.fromISO(NOW, { zone: "Asia/Dubai" }) };
    deps.clock = { now: () => mutable.now };
    const send = async () => {
      calls += 1;
      if (fail) throw new Error("telegram timeout");
      return { messageId: 9 };
    };
    const failed = await processDueReminders(deps, { workerId: "a", send });
    expect(failed.failed).toBe(1);
    expect(calls).toBe(1);
    const tooSoon = await processDueReminders(deps, { workerId: "b", send });
    expect(tooSoon.sent + tooSoon.failed + tooSoon.skipped).toBe(0);
    fail = false;
    mutable.now = mutable.now.plus({ minutes: 2 });
    const sent = await processDueReminders(deps, { workerId: "c", send });
    expect(sent.sent).toBe(1);
    expect(calls).toBe(2);
    const again = await processDueReminders(deps, { workerId: "d", send });
    expect(again.sent).toBe(0);
    expect(calls).toBe(2);
  });

  it("skips a delivery that was already marked sent", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    const { reminder } = await db.insertReminder({
      userId: user.id,
      title: "Printer",
      message: "Check the printer",
      kind: "once",
      timezone: "Asia/Dubai",
      nextRunAt: "2026-10-30T06:00:00.000Z",
      weekdays: [],
      intervalMinutes: null,
      status: "active",
      dedupeKey: "once|printer|sent|",
      createdAt: NOW,
    });
    await db.startDelivery(reminder.id, reminder.nextRunAt, NOW);
    await db.finishDelivery(reminder.id, reminder.nextRunAt, "sent", null, 4, NOW);
    let calls = 0;
    deps.clock = fixedClock("2026-10-30T10:05:00.000+04:00", "Asia/Dubai");
    const run = await processDueReminders(deps, {
      workerId: "retry",
      send: async () => {
        calls += 1;
        return { messageId: 1 };
      },
    });
    expect(run.skipped).toBe(1);
    expect(calls).toBe(0);
  });

  it("does not message a telegram user who has not started the bot", async () => {
    const { deps, db } = testDeps();
    await db.insertReminder({
      userId: "missing-user",
      title: "Nobody",
      message: "Do not send",
      kind: "once",
      timezone: "Asia/Dubai",
      nextRunAt: "2026-10-30T06:00:00.000Z",
      weekdays: [],
      intervalMinutes: null,
      status: "active",
      dedupeKey: "once|nobody|x|",
      createdAt: NOW,
    });
    let calls = 0;
    await processDueReminders(deps, {
      workerId: "none",
      send: async () => {
        calls += 1;
        return { messageId: 1 };
      },
    });
    expect(calls).toBe(0);
  });

  it("creates several reminders from one list and does not duplicate them", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    const message = [
      "Create reminders:",
      "- Check the printer at 3 PM",
      "- Call vendor tomorrow",
      "- Replace UPS battery",
    ].join("\n");
    const reply = await handleText(deps, user, message);
    expect(reply.text).toContain("Created 2 reminders:");
    expect(reply.text).toContain("Check the printer — Fri 30 Oct 2026, 3:00 PM");
    expect(reply.text).toContain("Call vendor — Sat 31 Oct 2026, 9:00 AM");
    expect(reply.text).toContain("Replace UPS battery (no time set)");
    expect(await db.listReminders(user.id)).toHaveLength(2);

    const again = await handleText(deps, user, message);
    expect(again.text).toContain("Already scheduled:");
    expect(again.text).not.toContain("Created 2 reminders:");
    expect(await db.listReminders(user.id)).toHaveLength(2);
  });

  it("schedules every reminder it can and asks only for a missing time", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    const reply = await handleText(
      deps,
      user,
      "Remind me to do the weekly Sunday speaker setup before 1 PM and the physical server check.",
    );
    expect(reply.text).toContain("Created 1 reminder:");
    expect(reply.text).toContain("weekly Sunday speaker setup — Sun 1 Nov 2026, 1:00 PM");
    expect(reply.text).toContain("physical server check (no time set)");
    expect(reply.text).toContain("When should the physical server check happen?");
    expect(reply.text).not.toContain("one reminder");
    const saved = await db.listReminders(user.id);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.kind).toBe("weekly");
  });

  it("keeps a single remind-me sentence on the one-reminder path", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    const reply = await handleText(deps, user, "Remind me tomorrow at 9 AM to check the server backup.");
    expect(reply.text).toContain("Scheduled reminder");
    expect(reply.text).not.toContain("Created");
    expect(await db.listReminders(user.id)).toHaveLength(1);
  });

  it("cancels a reminder only after confirmation", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    await handleText(deps, user, "Remind me in 30 minutes to call the network team about the printer.");
    const ask = await handleText(deps, user, "Cancel my reminder about the printer.");
    expect(ask.text).toContain("Reply YES");
    const done = await handleText(deps, user, "YES");
    expect(done.text).toContain("Cancelled reminder");
  });

  it("sends Done and Snooze buttons and updates the reminder from those taps", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    const { reminder } = await db.insertReminder({
      userId: user.id,
      title: "Backup",
      message: "Check the server backup",
      kind: "once",
      timezone: "Asia/Dubai",
      nextRunAt: "2026-10-30T06:00:00.000Z",
      weekdays: [],
      intervalMinutes: null,
      status: "active",
      dedupeKey: "once|backup|buttons|",
      createdAt: NOW,
    });
    const sent: Array<Array<{ label: string; data: string }> | undefined> = [];
    await processDueReminders(deps, {
      workerId: "buttons",
      send: async (_id, _text, buttons) => {
        sent.push(buttons);
        return { messageId: 3 };
      },
    });
    expect(sent[0]?.map((button) => button.label)).toEqual(["Done", "Snooze 1h"]);
    expect(sent[0]?.[0]?.data).toBe(`r:done:${reminder.id}`);

    const snoozed = await applyReminderButton(deps, user, "snooze", reminder.id);
    expect(snoozed.editText).toContain("Snoozed until");
    expect(snoozed.editText).toContain("11:00 AM");
    expect((await db.findReminderById(reminder.id))?.status).toBe("active");

    const finished = await applyReminderButton(deps, user, "done", reminder.id);
    expect(finished.editText).toContain("Done.");
    expect((await db.findReminderById(reminder.id))?.status).toBe("completed");

    const again = await applyReminderButton(deps, user, "done", reminder.id);
    expect(again.editText).toContain("Done.");
    expect((await db.findReminderById(reminder.id))?.status).toBe("completed");

    const missing = await applyReminderButton(deps, user, "snooze", "00000000-0000-4000-8000-000000000000");
    expect(missing.editText).toBeNull();
  });
});
