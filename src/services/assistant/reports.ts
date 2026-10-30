export interface Draft {
  text: string;
  missing: string[];
}

function has(text: string, pattern: RegExp): boolean {
  return pattern.test(text);
}

export function draftIncidentReport(facts: string): Draft {
  const body = facts.trim();
  const missing: string[] = [];
  if (!has(body, /\b(\d{1,2}:\d{2}|\d{1,2}\s*(am|pm)|today|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|this morning|this afternoon)\b/i)) {
    missing.push("When it started");
  }
  if (!has(body, /\b(room|floor|office|hotel|site|building|lobby|meeting)\b/i)) {
    missing.push("Where it happened");
  }
  if (!has(body, /\b(could not|cannot|can't|unable|down|outage|affected|no connection|not connect)\b/i)) {
    missing.push("Who or what was affected");
  }
  if (!has(body, /\b(checked|verified|tested|restarted|online|offline|logs)\b/i)) {
    missing.push("What you already checked");
  }
  if (!has(body, /\b(resolved|ongoing|monitoring|still|workaround|pending)\b/i)) {
    missing.push("Current status");
  }
  if (!has(body, /\b(next|will|plan to|follow up|escalate)\b/i)) {
    missing.push("Next action");
  }

  const lines = [
    "Incident report",
    "",
    "What you told me:",
    body || "(no details yet)",
    "",
    missing.length
      ? `Still needed before this is manager-ready:\n${missing.map((item) => `- ${item}`).join("\n")}`
      : "The main facts you listed are present. Read it once more before you send it.",
    "",
    "I did not add causes, times, names, or addresses that you did not write.",
  ];
  return { text: lines.join("\n"), missing };
}

export function draftShiftHandover(facts: string, openTasks: string[]): Draft {
  const missing: string[] = [];
  if (!facts.trim()) missing.push("What happened on your shift");
  if (openTasks.length === 0) missing.push("Open tasks, if any remain");
  const taskBlock = openTasks.length ? openTasks.map((task) => `- ${task}`).join("\n") : "- No open tasks are stored.";
  const text = [
    "Shift handover",
    "",
    "From your note:",
    facts.trim() || "(no shift note yet)",
    "",
    "Open tasks on record:",
    taskBlock,
    "",
    "I listed only stored tasks and the words you sent.",
  ].join("\n");
  return { text, missing };
}

export function draftDailySummary(input: {
  dateLabel: string;
  overdue: string[];
  dueToday: string[];
  pending: string[];
  reminders: string[];
}): string {
  const section = (title: string, rows: string[]) =>
    `${title}\n${rows.length ? rows.map((row) => `- ${row}`).join("\n") : "- None"}`;
  return [
    `Daily summary for ${input.dateLabel}`,
    "",
    section("Overdue", input.overdue),
    "",
    section("Due today", input.dueToday),
    "",
    section("Other open tasks", input.pending),
    "",
    section("Upcoming reminders", input.reminders),
    "",
    "This summary uses only records stored in your copilot.",
  ].join("\n");
}
