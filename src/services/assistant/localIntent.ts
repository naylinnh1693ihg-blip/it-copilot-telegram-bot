import { blankIntent, type Intent } from "../../types/intent.js";
import { matchDailyIntent } from "./dailyPatterns.js";

/** Local parses at or above this confidence are executed without a Grok classification call. */
export const CONFIDENT_LOCAL_CONFIDENCE = 0.9;

export function isConfidentLocalIntent(intent: Intent | null): intent is Intent {
  return !!intent && intent.confidence >= CONFIDENT_LOCAL_CONFIDENCE;
}

function clarify(question: string): Intent {
  return blankIntent({ intent: "clarify", clarification_question: question, confidence: 0.9 });
}

function withoutFinalPunctuation(text: string): string {
  return text.trim().replace(/[.?!]+$/, "").trim();
}

function splitTitleAndWhen(rest: string): { title: string; when: string } {
  const by = rest.match(/^(.*)\s+by\s+(.+)$/i);
  if (by?.[1] && by[2]) return { title: by[1].trim(), when: by[2].trim() };
  const tomorrow = rest.match(/^(.*)\s+tomorrow(?:\s+at\s+(.+))?$/i);
  if (tomorrow?.[1]) {
    return { title: tomorrow[1].trim(), when: tomorrow[2] ? `tomorrow at ${tomorrow[2].trim()}` : "tomorrow" };
  }
  const today = rest.match(/^(.*)\s+today(?:\s+at\s+(.+))?$/i);
  if (today?.[1]) return { title: today[1].trim(), when: today[2] ? today[2].trim() : "today" };
  return { title: rest.trim(), when: "" };
}

export function parseLocalIntent(input: string): Intent | null {
  const text = input.trim().replace(/\s+/g, " ");
  if (!text) return null;
  const plain = withoutFinalPunctuation(text);

  const daily = matchDailyIntent(plain);
  if (daily) return daily;

  if (/^(help|what can you do)$/i.test(plain)) return blankIntent({ intent: "help" });

  const webSearch = plain.match(
    /^(?:(?:please|can you|could you)\s+)?(?:search(?:\s+the)?\s+(?:web|internet|online)|look\s+up(?:\s+online)?|find\s+online)(?:\s+for)?\s*[:,-]?\s*(.+)$/i,
  );
  if (webSearch?.[1]) return blankIntent({ intent: "search_web", search_query: webSearch[1].trim(), tags: "explicit_web" });

  const summaryAt = plain.match(/^give me my daily summary at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm))$/i);
  if (summaryAt?.[1]) {
    return blankIntent({
      intent: "create_reminder",
      title: "Daily summary",
      details: "Daily summary",
      when_text: summaryAt[1],
      recurrence: "daily_summary",
    });
  }
  if (/^(give me my daily summary|daily summary|summarize my day)$/i.test(plain)) {
    return blankIntent({ intent: "generate_daily_summary" });
  }

  const snooze = plain.match(/^snooze(?: the current reminder)?(?: for (\d+)\s*(minute|minutes|hour|hours))?$/i);
  if (snooze) {
    const amount = snooze[1] ? Number(snooze[1]) : 15;
    const minutes = snooze[2]?.toLowerCase().startsWith("hour") ? amount * 60 : amount;
    return blankIntent({ intent: "snooze_reminder", snooze_minutes: minutes });
  }

  const cancel = plain.match(/^cancel my reminder about\s+(.+)$/i);
  if (cancel?.[1]) return blankIntent({ intent: "cancel_reminder", search_query: cancel[1].trim() });
  if (/^(?:please\s+)?(?:show|list|display)(?:\s+me)?(?:\s+my)?\s+reminders?$/i.test(plain)) {
    return blankIntent({ intent: "list_reminders" });
  }
  if (/^(?:please\s+)?what are my reminders$/i.test(plain)) return blankIntent({ intent: "list_reminders" });

  if (/^remind me\s+\d+\s+minutes?\s+before\s+my\b/i.test(plain) && !/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i.test(plain)) {
    return clarify("What time is the meeting? For example: remind me 15 minutes before 3 PM to join the meeting.");
  }

  const before = plain.match(/^remind me\s+(\d+\s+minutes?\s+before\s+\d{1,2}(?::\d{2})?\s*(?:am|pm))\s+to\s+(.+)$/i);
  if (before?.[1] && before[2]) {
    return blankIntent({ intent: "create_reminder", when_text: before[1], details: before[2].trim(), title: before[2].trim(), recurrence: "once" });
  }
  const relative = plain.match(/^remind me\s+(in\s+\d+\s+(?:minute|minutes|hour|hours))\s+to\s+(.+)$/i);
  if (relative?.[1] && relative[2]) {
    return blankIntent({ intent: "create_reminder", when_text: relative[1], details: relative[2].trim(), title: relative[2].trim(), recurrence: "once" });
  }
  const tomorrowReminder = plain.match(/^remind me\s+(tomorrow(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm))?)\s+to\s+(.+)$/i);
  if (tomorrowReminder?.[1] && tomorrowReminder[2]) {
    return blankIntent({
      intent: "create_reminder",
      when_text: tomorrowReminder[1],
      details: tomorrowReminder[2].trim(),
      title: tomorrowReminder[2].trim(),
      recurrence: "once",
    });
  }
  const weekly = plain.match(/^every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)),?\s*remind me to\s+(.+)$/i);
  if (weekly?.[1] && weekly[2] && weekly[3]) {
    return blankIntent({
      intent: "create_reminder",
      when_text: `every ${weekly[1]} at ${weekly[2]}`,
      details: weekly[3].trim(),
      title: weekly[3].trim(),
      recurrence: "weekly",
    });
  }

  const history = plain.match(/^(?:history|show history) (?:for|of)?\s*task\s+#?(\d+)$/i);
  if (history?.[1]) return blankIntent({ intent: "list_tasks", entity_number: Number(history[1]), tags: "history" });
  const complete = plain.match(/^(?:mark|set)\s+task\s+#?(\d+)\s+(?:as\s+)?completed$/i) ?? plain.match(/^(?:complete|finish)\s+task\s+#?(\d+)$/i);
  if (complete?.[1]) return blankIntent({ intent: "complete_task", entity_number: Number(complete[1]) });
  const remove = plain.match(/^delete\s+task\s+#?(\d+)$/i);
  if (remove?.[1]) return blankIntent({ intent: "delete_task", entity_number: Number(remove[1]) });
  const move = plain.match(/^move\s+task\s+#?(\d+)\s+to\s+tomorrow$/i);
  if (move?.[1]) return blankIntent({ intent: "update_task", entity_number: Number(move[1]), when_text: "tomorrow" });
  const progress = plain.match(/^(?:mark|set)\s+task\s+#?(\d+)\s+(?:as\s+)?in progress$/i);
  if (progress?.[1]) return blankIntent({ intent: "update_task", entity_number: Number(progress[1]), status: "in_progress" });

  if (/\boverdue\b/i.test(plain) && /\btasks?\b/i.test(plain)) return blankIntent({ intent: "list_tasks", list_filter: "overdue" });
  if (/\btoday'?s tasks\b|\btasks today\b/i.test(plain)) return blankIntent({ intent: "list_tasks", list_filter: "today" });

  const created = plain.match(/^(?:please\s+)?(?:create|add|make)\s+(?:a\s+)?(?:(low|normal|high|urgent)[- ]priority\s+)?task\s+(?:to\s+)?(.+)$/i);
  if (created?.[2]) {
    const parts = splitTitleAndWhen(created[2]);
    return blankIntent({
      intent: "create_task",
      title: parts.title,
      details: parts.title,
      priority: (created[1]?.toLowerCase() as Intent["priority"]) || "normal",
      when_text: parts.when,
    });
  }

  const under = plain.match(/^save this under\s+([^:]+):\s*(.+)$/i);
  if (under?.[1] && under[2]) {
    return blankIntent({ intent: "save_knowledge", category: under[1].trim(), details: under[2].trim(), title: under[2].trim() });
  }
  if (/^save this under\b/i.test(plain)) return clarify("What should I save? Add the details after a colon.");

  const command = plain.match(/^save this (.+?) and explain it:?\s*(.+)$/i);
  if (command?.[2]) {
    return blankIntent({
      intent: "save_knowledge",
      title: command[1]?.trim() || "Command",
      details: command[2].trim(),
      category: command[1]?.trim() || "",
      tags: "explain",
    });
  }
  if (/^save this\b/i.test(plain) && /explain it/i.test(plain)) {
    return clarify("Paste the command after 'explain it:'.");
  }

  const updateNote = plain.match(/^update my (.+?) notes?:\s*(.+)$/i);
  if (updateNote?.[1] && updateNote[2]) {
    return blankIntent({ intent: "update_note", search_query: updateNote[1].trim(), details: updateNote[2].trim() });
  }
  if (/^update my\b/i.test(plain) && /\bnotes?\b/i.test(plain)) {
    return clarify("Send the new text after a colon. Example: Update my printer notes: clear the queue, then power-cycle the printer.");
  }
  const deleteNote = plain.match(/^delete note\s+#?(\d+)$/i);
  if (deleteNote?.[1]) return blankIntent({ intent: "delete_note", entity_number: Number(deleteNote[1]) });

  const saved = plain.match(/^what information did i save about\s+(.+)$/i);
  if (saved?.[1]) return blankIntent({ intent: "search_notes", search_query: saved[1].trim() });
  const notes = plain.match(/^(?:find|search) my (?:old |previous )?notes about\s+(.+)$/i);
  if (notes?.[1]) return blankIntent({ intent: "search_notes", search_query: notes[1].trim() });
  const previous = plain.match(/^find my previous\s+(.+)$/i);
  if (previous?.[1]) return blankIntent({ intent: "search_knowledge", search_query: previous[1].trim() });
  const summarizeSaved = plain.match(/^summarize all my recent\s+(.+)$/i);
  if (summarizeSaved?.[1]) return blankIntent({ intent: "search_knowledge", search_query: summarizeSaved[1].trim(), tags: "summarize" });

  const renameDocument = plain.match(/^(?:rename|retitle|change the name of)\s+(?:my\s+)?(?:saved\s+)?document\s+#?(\d+)\s+(?:to|as|:)\s+(.+)$/i);
  if (renameDocument?.[1] && renameDocument[2]) {
    return blankIntent({ intent: "rename_document", entity_number: Number(renameDocument[1]), title: renameDocument[2].trim() });
  }
  if (/^(?:rename|retitle)\s+(?:my\s+)?(?:saved\s+)?document\b/i.test(plain)) {
    return clarify("Which document number should I rename, and what should its new title be? For example: Rename document 2 to Git Resources.");
  }

  const send = plain.match(/^send me the saved\s+(.+)$/i);
  if (send?.[1]) return blankIntent({ intent: "send_document", search_query: send[1].trim() });
  const documentSearch = plain.match(
    /^(?:please\s+)?(?:search|find|look)(?:\s+in)?(?:\s+(?:my|the))?\s+(?:documents?|docs|pdfs?|files?)(?:\s+for|\s*:)?\s*(.*)$/i,
  );
  if (documentSearch) {
    const query = documentSearch[1]?.trim() ?? "";
    if (!query) return clarify("What should I look for? For example: Search documents for printer IP.");
    return blankIntent({ intent: "search_documents", search_query: query });
  }
  const summarize = plain.match(/^summarize (?:this |my )?(pdf|document|file)?\s*(.*)$/i);
  if (summarize) return blankIntent({ intent: "summarize_document", search_query: summarize[2]?.trim() ?? "" });

  if (/incident report/i.test(plain)) return blankIntent({ intent: "prepare_incident_report", details: text });
  if (/shift handover|handover report/i.test(plain)) return blankIntent({ intent: "prepare_shift_handover", details: text });
  const english = plain.match(/^(?:improve|polish|rewrite) (?:my |this )?(?:english|wording):?\s*(.+)$/i);
  if (english?.[1]) return blankIntent({ intent: "improve_english", details: english[1].trim() });

  return null;
}
