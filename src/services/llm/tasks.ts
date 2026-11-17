/**
 * Work the bot can send to Claude. Kept free of other imports so config can use it.
 * - extract: short structured calls (intent, tasks, reminders, equipment cards)
 * - answer: plain-text answers (knowledge answers, saved-record answers)
 * - document: document analysis, including image pages
 * Web search, tool calls, and embeddings always stay on xAI.
 */
export const CLAUDE_TASKS = ["extract", "answer", "document"] as const;
export type ClaudeTask = (typeof CLAUDE_TASKS)[number];
