/**
 * Work the bot can send to Claude. Kept free of other imports so config can use it.
 * - extract: short structured calls (intent, tasks, reminders, equipment cards)
 * - answer: plain-text answers (knowledge answers, saved-record answers)
 * - document: document analysis, including image pages
 * - tools: the model asks to run the bot's own tools (save a note, search notes, list or create tasks)
 * - web: web search answers, using Anthropic's server-side search
 * xAI's X search and code interpreter, and embeddings, always stay on xAI.
 */
export const CLAUDE_TASKS = ["extract", "answer", "document", "tools", "web"] as const;
export type ClaudeTask = (typeof CLAUDE_TASKS)[number];
