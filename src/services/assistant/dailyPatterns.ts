import { blankIntent, type Intent } from "../../types/intent.js";

/**
 * High-frequency commands handled with no Grok call.
 * Add a function and append it to DAILY_MATCHERS. Earlier entries win.
 */
type DailyMatcher = (plain: string) => Intent | null;

function clarify(question: string): Intent {
  return blankIntent({ intent: "clarify", clarification_question: question, confidence: 0.9 });
}

function listTasks(filter: Intent["list_filter"]): Intent {
  return blankIntent({ intent: "list_tasks", list_filter: filter });
}

/**
 * Tasks completed today. "Today" is the user's timezone (APP_TIMEZONE if unset),
 * from local midnight inclusive to the next local midnight exclusive.
 * "What I closed today", "What did I close/finish today", "Tasks I closed today", "Closed today".
 */
export function matchClosedToday(plain: string): Intent | null {
  if (
    /^(?:please\s+)?(?:what(?:\s+did|\s+have)?\s+i\s+(?:close|closed|finish|finished|complete|completed)\s+today|what\s+i\s+(?:closed|finished|completed)\s+today|(?:tasks|task)\s+i\s+(?:closed|finished|completed)\s+today|closed\s+today)$/i.test(
      plain,
    )
  ) {
    return blankIntent({ intent: "list_tasks", tags: "closed_today" });
  }
  return null;
}

/** "show my tasks", "list tasks", "my pending tasks", "open tasks", "what's on my list". */
export function matchTaskList(plain: string): Intent | null {
  if (/^(?:please\s+)?what(?:'s|s| is) on my list$/i.test(plain)) return listTasks("pending");

  const listed = plain.match(
    /^(?:please\s+)?(?:(?:show|list|display)(?:\s+me)?(?:\s+(?:my|the))?|what are(?:\s+my)?)\s+(pending|open|today(?:'s)?|overdue)?\s*tasks?$/i,
  );
  if (listed) {
    const which = listed[1]?.toLowerCase() ?? "";
    if (which.startsWith("today")) return listTasks("today");
    if (which === "overdue") return listTasks("overdue");
    return listTasks("pending");
  }
  if (/^(?:my\s+)?(?:pending|open)\s+tasks?$/i.test(plain) || /^my tasks$/i.test(plain)) return listTasks("pending");
  return null;
}

const NOTE_FORMS = [
  /^(?:please\s+)?remember this\s*[:,-]?\s*(.*)$/i,
  /^(?:please\s+)?remember\s*:\s*(.*)$/i,
  /^(?:please\s+)?note this\s*[:,-]?\s*(.*)$/i,
  /^(?:please\s+)?note\s*:\s*(.*)$/i,
  /^(?:please\s+)?save this\s*[:,-]?\s*(.*)$/i,
];

/** "Remember this:", "remember:", "note this", "note:", "save this". */
export function matchSaveNote(plain: string): Intent | null {
  if (/^save this under\b/i.test(plain)) return null;
  if (/^save this\b/i.test(plain) && /\bexplain it\b/i.test(plain)) return null;
  const fromDocument = plain.match(
    /^(?:please\s+)?(?:remember this|note this|save this)(?:\s+as a note)?\s+from\s+(?:the\s+)?(?:document|pdf|file)\s+#?(\d{1,7})\s*[:,-]?\s*(.+)$/i,
  );
  if (fromDocument?.[1] && fromDocument[2]) {
    return blankIntent({
      intent: "save_note",
      details: fromDocument[2].trim(),
      title: fromDocument[2].trim(),
      entity_number: Number(fromDocument[1]),
      tags: "from_document",
    });
  }
  const fromLatestDocument = plain.match(
    /^(?:please\s+)?(?:remember this|note this|save this)(?:\s+as a note)?\s+from\s+(?:the\s+)?(?:pdf|document|file)\s*[:,-]?\s*(.+)$/i,
  );
  if (fromLatestDocument?.[1] && !/^\d/.test(fromLatestDocument[1])) {
    return blankIntent({
      intent: "save_note",
      details: fromLatestDocument[1].trim(),
      title: fromLatestDocument[1].trim(),
      tags: "from_recent_document",
    });
  }
  if (/^remember how\b/i.test(plain)) {
    return clarify("What should I remember about that? Send the steps or the fix, starting with 'Remember this:'.");
  }
  for (const form of NOTE_FORMS) {
    const match = plain.match(form);
    if (!match) continue;
    const body = match[1]?.trim() ?? "";
    if (!body) return clarify("What should I remember? Add the text after 'Remember this:'.");
    return blankIntent({ intent: "save_note", details: body, title: body });
  }
  return null;
}

/**
 * This week's AI cost, from ai_usage. No model call.
 * "Week cost", "This week's cost", "AI cost this week",
 * "How much did I spend this week", "Usage cost this week".
 */
export function matchWeekCost(plain: string): Intent | null {
  if (
    /^(?:please\s+)?(?:(?:what(?:'s| is|s)\s+)?(?:the\s+|my\s+)?(?:week cost|this week(?:'s|s)? cost)|(?:ai|usage) cost this week|how much did i spend this week)$/i.test(
      plain,
    )
  ) {
    return blankIntent({ intent: "help", tags: "week_cost" });
  }
  return null;
}

export const DAILY_MATCHERS: DailyMatcher[] = [matchClosedToday, matchWeekCost, matchTaskList, matchSaveNote];

export function matchDailyIntent(plain: string): Intent | null {
  for (const match of DAILY_MATCHERS) {
    const intent = match(plain);
    if (intent) return intent;
  }
  return null;
}
