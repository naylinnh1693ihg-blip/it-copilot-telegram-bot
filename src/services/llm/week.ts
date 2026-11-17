import type { DateTime } from "luxon";
import { toIso } from "../../utils/time.js";
import { WEEKDAYS, type Weekday } from "./tasks.js";

/** Start of the current budget week as a UTC ISO time: the most recent `weekday` at 00:00 in now's zone. */
export function budgetWeekStart(now: DateTime, weekday: Weekday): string {
  const target = WEEKDAYS.indexOf(weekday) + 1;
  const back = (now.weekday - target + 7) % 7;
  return toIso(now.startOf("day").minus({ days: back }));
}
