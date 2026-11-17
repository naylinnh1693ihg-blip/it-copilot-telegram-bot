import { DateTime } from "luxon";
import type { Deps } from "../../app/deps.js";
import { isLeapYear } from "../../forms/checks.js";
import type { Contact, User } from "../../types/models.js";
import { toIso } from "../../utils/time.js";

export interface BirthdayEntry {
  contactId: string;
  number: number;
  name: string;
  department: string;
  dateLabel: string;
  when: string;
  age: number | null;
  sortAt: string;
  month: number;
}

export function calendarBirthday(year: number, month: number, day: number, zone: string): DateTime {
  const usedDay = month === 2 && day === 29 && !isLeapYear(year) ? 28 : day;
  return DateTime.fromObject({ year, month, day: usedDay }, { zone });
}

export function nextCelebration(now: DateTime, month: number, day: number): DateTime {
  const zone = now.zoneName ?? "Asia/Dubai";
  let occurs = calendarBirthday(now.year, month, day, zone);
  if (occurs.startOf("day") < now.startOf("day")) occurs = calendarBirthday(now.year + 1, month, day, zone);
  return occurs;
}

export function birthdayPlan(contact: Contact, now: DateTime): { fireAt: DateTime; occurs: DateTime; message: string } | null {
  if (!contact.birthDay || !contact.birthMonth || contact.birthdayReminder === "none") return null;
  const zone = now.zoneName ?? "Asia/Dubai";
  let occurs = nextCelebration(now.setZone(zone), contact.birthMonth, contact.birthDay);
  let fire = (contact.birthdayReminder === "day_before" ? occurs.minus({ days: 1 }) : occurs).set({
    hour: 9,
    minute: 0,
    second: 0,
    millisecond: 0,
  });
  if (fire <= now) {
    occurs = calendarBirthday(occurs.year + 1, contact.birthMonth, contact.birthDay, zone);
    fire = (contact.birthdayReminder === "day_before" ? occurs.minus({ days: 1 }) : occurs).set({
      hour: 9,
      minute: 0,
      second: 0,
      millisecond: 0,
    });
  }
  const when = contact.birthdayReminder === "day_before" ? "tomorrow" : "today";
  return {
    fireAt: fire,
    occurs,
    message: `${contact.fullName}'s birthday is ${when} (${occurs.toFormat("d MMMM")}).`,
  };
}

function whenLabel(now: DateTime, occurs: DateTime): string {
  const days = Math.round(occurs.startOf("day").diff(now.startOf("day"), "days").days);
  if (days <= 0) return "Today";
  if (days === 1) return "Tomorrow";
  return `In ${days} days`;
}

export function birthdayEntries(contacts: Contact[], now: DateTime, scope: "upcoming" | "month"): BirthdayEntry[] {
  const zoneNow = now.setZone(now.zoneName ?? "Asia/Dubai");
  const entries: BirthdayEntry[] = [];
  for (const contact of contacts) {
    if (contact.deletedAt || !contact.birthDay || !contact.birthMonth) continue;
    if (scope === "month" && contact.birthMonth !== zoneNow.month) continue;
    const occurs = nextCelebration(zoneNow, contact.birthMonth, contact.birthDay);
    entries.push({
      contactId: contact.id,
      number: contact.contactNumber,
      name: contact.fullName,
      department: contact.department,
      dateLabel: occurs.toFormat("d MMMM"),
      when: whenLabel(zoneNow, occurs),
      age: contact.birthYear == null ? null : occurs.year - contact.birthYear,
      sortAt: occurs.toISO() ?? "",
      month: contact.birthMonth,
    });
  }
  entries.sort((left, right) => left.sortAt.localeCompare(right.sortAt) || left.name.localeCompare(right.name));
  return entries;
}

export function formatBirthdayReply(entries: BirthdayEntry[], scope: "upcoming" | "month"): string {
  if (entries.length === 0) return scope === "month" ? "No birthdays this month." : "No birthdays are saved yet.";
  const heading = scope === "month" ? "Birthdays this month" : "Upcoming birthdays";
  const lines = entries.map((entry) => {
    const place = entry.department ? `, ${entry.department}` : "";
    const age = entry.age == null ? "" : `, turns ${entry.age}`;
    return `${entry.name}${place} — ${entry.when}, ${entry.dateLabel}${age}`;
  });
  return [heading, ...lines].join("\n");
}

export async function syncBirthdayReminder(deps: Deps, contact: Contact): Promise<void> {
  const key = `birthday:${contact.id}`;
  const existing = (await deps.db.listReminders(contact.userId)).find((reminder) => reminder.status === "active" && reminder.dedupeKey === key);
  const user = await deps.db.findUserById(contact.userId);
  const zone = user?.timezone || "Asia/Dubai";
  const now = deps.clock.now().setZone(zone);
  const plan = contact.deletedAt ? null : birthdayPlan(contact, now);
  const at = toIso(deps.clock.now());
  if (!plan) {
    if (existing) {
      await deps.db.updateReminder({ ...existing, status: "cancelled", updatedAt: at });
    }
    return;
  }
  if (existing) {
    await deps.db.updateReminder({
      ...existing,
      title: `${contact.fullName}'s birthday`,
      message: plan.message,
      kind: "yearly",
      timezone: zone,
      nextRunAt: toIso(plan.fireAt),
      updatedAt: at,
    });
    return;
  }
  await deps.db.insertReminder({
    userId: contact.userId,
    title: `${contact.fullName}'s birthday`,
    message: plan.message,
    kind: "yearly",
    timezone: zone,
    nextRunAt: toIso(plan.fireAt),
    weekdays: [],
    intervalMinutes: null,
    status: "active",
    dedupeKey: key,
    createdAt: at,
  });
}

export async function listBirthdayEntries(deps: Deps, user: User, scope: "upcoming" | "month"): Promise<BirthdayEntry[]> {
  const contacts = await deps.db.listContacts(user.id);
  return birthdayEntries(contacts, deps.clock.now().setZone(user.timezone || "Asia/Dubai"), scope);
}

export function parseBirthdayQuestion(text: string): "upcoming" | "month" | null {
  const value = text.trim().replace(/[.?!]+$/g, "");
  if (/^birthdays?$/i.test(value)) return "upcoming";
  if (/^whose birthday is this month$/i.test(value)) return "month";
  return null;
}
