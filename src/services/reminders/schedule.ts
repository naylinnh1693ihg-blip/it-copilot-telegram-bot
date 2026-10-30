import { DateTime } from "luxon";
import type { ReminderKind } from "../../types/models.js";
import { nextLocalTime, nextWeekday, parseClock, toIso, weekdayName } from "../../utils/time.js";

export interface ParsedSchedule {
  kind: ReminderKind;
  at: DateTime;
  weekdays: number[];
  intervalMinutes: number | null;
}

export function parseSchedule(text: string, now: DateTime): ParsedSchedule | null {
  const value = text.trim();
  const relative = value.match(/^in\s+(\d+)\s*(minute|minutes|hour|hours)$/i);
  if (relative?.[1] && relative[2]) {
    const amount = Number(relative[1]);
    const minutes = relative[2].toLowerCase().startsWith("hour") ? amount * 60 : amount;
    return { kind: "once", at: now.plus({ minutes }), weekdays: [], intervalMinutes: null };
  }

  const before = value.match(/^(\d+)\s+minutes?\s+before\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm))$/i);
  if (before?.[1] && before[2]) {
    const clock = parseClock(before[2]);
    if (!clock) return null;
    const event = nextLocalTime(now, clock.hour, clock.minute);
    return {
      kind: "once",
      at: event.minus({ minutes: Number(before[1]) }),
      weekdays: [],
      intervalMinutes: null,
    };
  }

  const everyWeek = value.match(/^(?:every\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm))$/i);
  if (everyWeek?.[1] && everyWeek[2]) {
    const weekday = weekdayName(everyWeek[1]);
    const clock = parseClock(everyWeek[2]);
    if (!weekday || !clock) return null;
    return {
      kind: "weekly",
      at: nextWeekday(now, weekday, clock.hour, clock.minute),
      weekdays: [weekday],
      intervalMinutes: null,
    };
  }

  const daily = value.match(/^(?:every day|daily)\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm))$/i);
  if (daily?.[1]) {
    const clock = parseClock(daily[1]);
    if (!clock) return null;
    return { kind: "daily", at: nextLocalTime(now, clock.hour, clock.minute), weekdays: [], intervalMinutes: null };
  }

  const tomorrow = value.match(/^tomorrow(?:\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)))?$/i);
  if (tomorrow) {
    const clock = tomorrow[1] ? parseClock(tomorrow[1]) : { hour: 9, minute: 0 };
    if (!clock) return null;
    return {
      kind: "once",
      at: now.plus({ days: 1 }).set({ hour: clock.hour, minute: clock.minute, second: 0, millisecond: 0 }),
      weekdays: [],
      intervalMinutes: null,
    };
  }

  const clockOnly = parseClock(value.replace(/^by\s+/i, ""));
  if (clockOnly) {
    return { kind: "once", at: nextLocalTime(now, clockOnly.hour, clockOnly.minute), weekdays: [], intervalMinutes: null };
  }

  const dated = value.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}))?$/);
  if (dated?.[1]) {
    const clock = dated[2] ? parseClock(dated[2]) : { hour: 9, minute: 0 };
    if (!clock) return null;
    const at = DateTime.fromISO(dated[1], { zone: now.zone }).set({
      hour: clock.hour,
      minute: clock.minute,
      second: 0,
      millisecond: 0,
    });
    if (!at.isValid) return null;
    return { kind: "once", at, weekdays: [], intervalMinutes: null };
  }

  return null;
}

export function advanceOccurrence(
  kind: ReminderKind,
  occurrenceIso: string,
  zone: string,
  intervalMinutes: number | null,
): string | null {
  if (kind === "once") return null;
  const occurrence = DateTime.fromISO(occurrenceIso).setZone(zone);
  if (!occurrence.isValid) return null;
  if (kind === "interval") {
    if (!intervalMinutes || intervalMinutes <= 0) return null;
    return toIso(occurrence.plus({ minutes: intervalMinutes }));
  }
  if (kind === "weekly") return toIso(occurrence.plus({ weeks: 1 }));
  return toIso(occurrence.plus({ days: 1 }));
}

export function reminderDedupeKey(input: {
  kind: ReminderKind;
  title: string;
  at: DateTime;
  weekday: number | null;
}): string {
  const local = input.at.toFormat("yyyy-LL-dd HH:mm");
  const day = input.kind === "once" ? local : input.at.toFormat("HH:mm");
  return [input.kind, input.title.trim().toLowerCase(), day, input.weekday ?? ""].join("|").slice(0, 300);
}
