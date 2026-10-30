import { DateTime, IANAZone } from "luxon";

export interface Clock {
  now(): DateTime;
}

export function assertZone(zone: string): void {
  if (!IANAZone.isValidZone(zone)) {
    throw new Error(`APP_TIMEZONE is not a valid IANA time zone: ${zone}`);
  }
}

export function zoneClock(zone: string): Clock {
  assertZone(zone);
  return { now: () => DateTime.now().setZone(zone) };
}

export function fixedClock(iso: string, zone: string): Clock {
  assertZone(zone);
  const now = DateTime.fromISO(iso, { zone });
  if (!now.isValid) throw new Error(`Invalid clock time: ${iso}`);
  return { now: () => now };
}

export function toIso(value: DateTime): string {
  const iso = value.toUTC().toISO();
  if (!iso) throw new Error("Could not format a date.");
  return iso;
}

export function formatWhen(iso: string | null, zone: string): string {
  if (!iso) return "no time set";
  const value = DateTime.fromISO(iso).setZone(zone);
  if (!value.isValid) return "invalid time";
  return value.toFormat("ccc d LLL yyyy, h:mm a");
}

export interface ClockTime {
  hour: number;
  minute: number;
}

export function parseClock(text: string): ClockTime | null {
  const match = text.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!match?.[1]) return null;
  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3]?.toLowerCase();
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === "pm" && hour !== 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
  } else if (hour > 23) {
    return null;
  } else if (!match[2] && hour <= 12) {
    return null;
  }
  return { hour, minute };
}

export function atLocalTime(now: DateTime, hour: number, minute: number, dayOffset = 0): DateTime {
  return now.plus({ days: dayOffset }).set({ hour, minute, second: 0, millisecond: 0 });
}

export function nextLocalTime(now: DateTime, hour: number, minute: number): DateTime {
  const today = atLocalTime(now, hour, minute, 0);
  if (today > now) return today;
  return atLocalTime(now, hour, minute, 1);
}

const WEEKDAYS: Record<string, number> = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 7,
};

export function nextWeekday(now: DateTime, weekday: number, hour: number, minute: number): DateTime {
  let at = atLocalTime(now, hour, minute, 0);
  const delta = (weekday - at.weekday + 7) % 7;
  at = at.plus({ days: delta });
  if (at <= now) at = at.plus({ days: 7 });
  return at;
}

export function weekdayName(value: string): number | null {
  return WEEKDAYS[value.trim().toLowerCase()] ?? null;
}
