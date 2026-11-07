import { z } from "zod";
import type { Deps } from "../../app/deps.js";
import type { User } from "../../types/models.js";
import { createManyTasks, type TaskDraft } from "../assistant/multiTask.js";
import { attachNoteLinks } from "../notes/links.js";
import { indexSavedText } from "../rag/index.js";
import { matchCategory } from "../knowledge/categories.js";
import { cleanText, secretRisk } from "../../utils/text.js";
import { toIso } from "../../utils/time.js";

/**
 * Responses API tool names. xAI's Python SDK calls hosted code execution
 * `code_execution()`; the Responses API type is `code_interpreter`. It runs
 * on xAI's servers. This process does not execute model-written code.
 */
export const BUILTIN_TOOLS = ["web_search", "x_search", "code_interpreter"] as const;
export const CUSTOM_TOOLS = ["save_note", "search_local_knowledge", "get_open_tasks", "create_tasks"] as const;
export type BuiltinTool = (typeof BUILTIN_TOOLS)[number];
export type CustomTool = (typeof CUSTOM_TOOLS)[number];
export type ToolKind = BuiltinTool | CustomTool;

const SaveNoteArgs = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(8000),
}).strict();

const SearchArgs = z.object({
  query: z.string().min(1).max(200),
}).strict();

const OpenTasksArgs = z.object({}).strict();

const CreateTasksArgs = z.object({
  tasks: z.array(z.string().min(1).max(200)).min(1).max(15),
}).strict();

function functionTool(name: CustomTool, description: string, parameters: Record<string, unknown>): Record<string, unknown> {
  return { type: "function", name, description, parameters };
}

export const CUSTOM_TOOL_SCHEMAS: Record<CustomTool, Record<string, unknown>> = {
  save_note: functionTool("save_note", "Save one note the user explicitly asked to keep. Never store passwords, API keys, tokens, or private keys.", {
    type: "object",
    additionalProperties: false,
    required: ["title", "content"],
    properties: {
      title: { type: "string", description: "Short note title" },
      content: { type: "string", description: "Note text to store" },
    },
  }),
  search_local_knowledge: functionTool(
    "search_local_knowledge",
    "Search this user's saved notes, knowledge entries, and document text. Use this before the web for workplace facts.",
    {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", description: "Words to look up in saved records" },
      },
    },
  ),
  get_open_tasks: functionTool("get_open_tasks", "Return the user's open tasks (pending or in progress).", {
    type: "object",
    additionalProperties: false,
    required: [],
    properties: {},
  }),
  create_tasks: functionTool("create_tasks", "Create one or more tasks the user asked for. Each string is a task title.", {
    type: "object",
    additionalProperties: false,
    required: ["tasks"],
    properties: {
      tasks: {
        type: "array",
        maxItems: 15,
        items: { type: "string" },
        description: "Task titles to create",
      },
    },
  }),
};

export function toolDefinitions(kinds: ToolKind[]): Array<Record<string, unknown>> {
  const tools: Array<Record<string, unknown>> = [];
  if (kinds.includes("web_search")) tools.push({ type: "web_search" });
  if (kinds.includes("x_search")) tools.push({ type: "x_search" });
  if (kinds.includes("code_interpreter")) tools.push({ type: "code_interpreter" });
  for (const name of CUSTOM_TOOLS) {
    if (kinds.includes(name)) tools.push(CUSTOM_TOOL_SCHEMAS[name]);
  }
  return tools;
}

/** Which tools this message needs. Everyday local commands are handled before this runs. */
export function selectTools(text: string): ToolKind[] {
  const kinds: ToolKind[] = [];
  const news = /\b(latest news|news about|search the (web|internet)|look up online|current events|what(?:'s| is) the latest)\b/i.test(text);
  const onX = /\b(on x|x\.com|twitter|tweet|x search)\b/i.test(text);
  if (news) {
    kinds.push("web_search", "x_search");
  } else if (onX) {
    kinds.push("x_search");
  }
  if (/\b(calculate|average|median|percentage|sum of|from this table)\b/i.test(text)) kinds.push("code_interpreter");
  if (/\b(save (this|that|it) as a note|save a note|make a note)\b/i.test(text)) kinds.push("save_note");
  if (/\b(search (my )?(notes|knowledge|documents)|what did i save|local knowledge)\b/i.test(text)) kinds.push("search_local_knowledge");
  if (/\b(open tasks|my open tasks|what are my tasks)\b/i.test(text)) kinds.push("get_open_tasks");
  if (/\b(create tasks|add these tasks|make tasks)\b/i.test(text)) kinds.push("create_tasks");
  return kinds;
}

export async function executeCustomTool(deps: Deps, user: User, name: string, rawArguments: string): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments || "{}");
  } catch {
    return { ok: false, error: "Invalid arguments." };
  }

  if (name === "save_note") {
    const args = SaveNoteArgs.safeParse(parsed);
    if (!args.success) return { ok: false, error: "Invalid arguments." };
    const title = cleanText(args.data.title, 200);
    const content = cleanText(args.data.content, 8000);
    const risk = secretRisk(title) || secretRisk(content);
    if (risk) return { ok: false, error: `Not saved. The text looks like a ${risk}.` };
    const now = toIso(deps.clock.now());
    const note = await deps.db.insertNote({
      userId: user.id,
      title: title || content.slice(0, 80),
      content,
      category: matchCategory(`${title} ${content}`),
      tags: [],
      createdAt: now,
    });
    await deps.db.writeAudit({
      userId: user.id,
      action: "note.create",
      entity: "note",
      entityId: note.id,
      metadata: { noteNumber: note.noteNumber, via: "tool" },
      createdAt: now,
    }).catch(() => undefined);
    await attachNoteLinks(deps, user, note, { useConversation: true });
    await indexSavedText(deps, {
      userId: user.id,
      source: "note",
      sourceId: note.id,
      sourceNumber: note.noteNumber,
      title: note.title,
      text: `${note.title}\n${note.content}`,
    });
    return { ok: true, noteNumber: note.noteNumber, title: note.title };
  }

  if (name === "search_local_knowledge") {
    const args = SearchArgs.safeParse(parsed);
    if (!args.success) return { ok: false, error: "Invalid arguments." };
    const hits = await deps.db.searchSavedText(user.id, args.data.query);
    return {
      ok: true,
      hits: hits.map((hit) => ({
        source: hit.source,
        number: hit.sourceNumber,
        title: hit.title,
        excerpt: hit.excerpt,
        similarity: hit.similarity,
      })),
    };
  }

  if (name === "get_open_tasks") {
    const args = OpenTasksArgs.safeParse(parsed);
    if (!args.success) return { ok: false, error: "Invalid arguments." };
    const tasks = (await deps.db.listTasks(user.id)).filter((task) => task.status === "pending" || task.status === "in_progress");
    return {
      ok: true,
      tasks: tasks.map((task) => ({
        taskNumber: task.taskNumber,
        title: task.title,
        status: task.status,
        priority: task.priority,
        dueAt: task.dueAt,
      })),
    };
  }

  if (name === "create_tasks") {
    const args = CreateTasksArgs.safeParse(parsed);
    if (!args.success) return { ok: false, error: "Invalid arguments." };
    const drafts: TaskDraft[] = args.data.tasks.map((title) => ({ title: cleanText(title, 200), notes: "" })).filter((task) => task.title.length >= 2);
    if (drafts.length === 0) return { ok: false, error: "No task titles to create." };
    const reply = await createManyTasks(deps, user, drafts);
    const saved = reply.text.startsWith("Created ");
    return { ok: saved, message: reply.text };
  }

  return { ok: false, error: "Unknown tool." };
}
