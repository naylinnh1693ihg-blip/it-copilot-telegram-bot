import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { processDueReminders } from "../src/jobs/processReminders.js";
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

  it("cancels a reminder only after confirmation", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    await handleText(deps, user, "Remind me in 30 minutes to call the network team about the printer.");
    const ask = await handleText(deps, user, "Cancel my reminder about the printer.");
    expect(ask.text).toContain("Reply YES");
    const done = await handleText(deps, user, "YES");
    expect(done.text).toContain("Cancelled reminder");
  });
});
