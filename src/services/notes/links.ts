import type { Deps } from "../../app/deps.js";
import type { DocumentRecord, Note, User } from "../../types/models.js";
import { redactString } from "../../utils/text.js";

const GENERIC_TITLES = new Set(["general", "document", "documents", "pdf", "file", "files", "note", "notes", "scan", "image"]);

export interface NoteLinkResult {
  tasks: number[];
  documents: number[];
  missingTasks: number[];
  missingDocuments: number[];
  missingRecentDocument: boolean;
  createdTasks: number;
  createdDocuments: number;
}

export interface NoteLinkOptions {
  /** Text to scan for "task 14" and "document 3". Defaults to the note title and body. */
  text?: string;
  taskNumbers?: number[];
  documentNumbers?: number[];
  /** When the note itself names no task or document, use the previous user message if it names exactly one. */
  useConversation?: boolean;
  /** "from the pdf" with no number: link the newest saved document. */
  useRecentDocument?: boolean;
}

export function emptyNoteLinks(): NoteLinkResult {
  return { tasks: [], documents: [], missingTasks: [], missingDocuments: [], missingRecentDocument: false, createdTasks: 0, createdDocuments: 0 };
}

export function mentionedRecordNumbers(text: string): { tasks: number[]; documents: number[] } {
  const tasks: number[] = [];
  const documents: number[] = [];
  for (const match of text.matchAll(/\btasks?\s+#?(\d{1,7})\b/gi)) {
    const number = Number(match[1]);
    if (number > 0) tasks.push(number);
  }
  for (const match of text.matchAll(/\b(?:documents?|pdfs?|files?)\s+#?(\d{1,7})\b/gi)) {
    const number = Number(match[1]);
    if (number > 0) documents.push(number);
  }
  return { tasks: unique(tasks), documents: unique(documents) };
}

export interface NoteLinkCommand {
  noteNumber: number | "latest";
  taskNumber?: number;
  documentNumber?: number;
}

/** "link note 2 to task 14", "link this note to document 3", or both targets. */
export function parseNoteLinkCommand(input: string): NoteLinkCommand | "clarify" | null {
  const plain = input.trim().replace(/\s+/g, " ").replace(/[.?!]+$/, "");
  const match = plain.match(/^(?:please\s+)?link\s+(note\s+#?(\d+)|this note)\s+to\s+(.+)$/i);
  if (!match?.[3]) {
    if (/^(?:please\s+)?link\s+(?:this\s+)?note\b/i.test(plain)) return "clarify";
    return null;
  }
  const task = match[3].match(/\btasks?\s+#?(\d{1,7})\b/i);
  const document = match[3].match(/\b(?:documents?|pdfs?|files?)\s+#?(\d{1,7})\b/i);
  if (!task?.[1] && !document?.[1]) return "clarify";
  return {
    noteNumber: match[2] ? Number(match[2]) : "latest",
    taskNumber: task?.[1] ? Number(task[1]) : undefined,
    documentNumber: document?.[1] ? Number(document[1]) : undefined,
  };
}

export function formatNoteLinks(result: NoteLinkResult): string {
  const parts = [
    result.tasks.map((number) => `task ${number}`).join(", "),
    result.documents.map((number) => `document ${number}`).join(", "),
  ].filter((part) => part.length > 0);
  if (parts.length === 0) return "";
  return `\nLinked to ${parts.join(" and ")}.`;
}

export async function linkNoteCommand(deps: Pick<Deps, "db" | "logger">, user: User, command: NoteLinkCommand): Promise<string> {
  const notes = await deps.db.listNotes(user.id);
  const note = command.noteNumber === "latest"
    ? notes.reduce<Note | null>((latest, item) => (!latest || item.noteNumber > latest.noteNumber ? item : latest), null)
    : notes.find((item) => item.noteNumber === command.noteNumber) ?? null;
  if (!note) {
    return command.noteNumber === "latest" ? "You don't have a note to link yet." : `I don't have note ${command.noteNumber}.`;
  }
  const result = await attachNoteLinks(deps, user, note, {
    text: "",
    taskNumbers: command.taskNumber ? [command.taskNumber] : [],
    documentNumbers: command.documentNumber ? [command.documentNumber] : [],
  });
  const linked = formatNoteLinks(result).trim();
  const missing = [
    ...result.missingTasks.map((number) => `task ${number}`),
    ...result.missingDocuments.map((number) => `document ${number}`),
  ];
  if (linked && missing.length === 0) return `Linked note ${note.noteNumber} to ${linked.replace(/^Linked to\s+/i, "")}`;
  if (linked) return `Linked note ${note.noteNumber} to ${linked.replace(/^Linked to\s+/i, "").replace(/\.$/, "")}. I don't have ${missing.join(" or ")}.`;
  return `I don't have ${missing.join(" or ")}.`;
}

/**
 * Upserts note_tasks and note_documents for one note.
 * The tables store only the two ids. A repeat call does not add a second row.
 */
export async function attachNoteLinks(
  deps: Pick<Deps, "db" | "logger">,
  user: User,
  note: Note,
  options: NoteLinkOptions = {},
): Promise<NoteLinkResult> {
  try {
    if (note.userId !== user.id || note.deletedAt) return emptyNoteLinks();
    const text = options.text ?? `${note.title}\n${note.content}`;
    const mentioned = mentionedRecordNumbers(text);
    const taskNumbers = unique([...(options.taskNumbers ?? []), ...mentioned.tasks]);
    const documentNumbers = unique([...(options.documentNumbers ?? []), ...mentioned.documents]);
    const explicitTasks = new Set(options.taskNumbers ?? []);
    const explicitDocuments = new Set(options.documentNumbers ?? []);

    if (options.useConversation && taskNumbers.length === 0) {
      const discussed = await discussedNumber(deps, user.id, "task");
      if (discussed) taskNumbers.push(discussed);
    }
    if (options.useConversation && documentNumbers.length === 0) {
      const discussed = await discussedNumber(deps, user.id, "document");
      if (discussed) documentNumbers.push(discussed);
    }

    const documents = await deps.db.listDocuments(user.id);
    let missingRecentDocument = false;
    if (options.useRecentDocument && documentNumbers.length === 0) {
      const latest = documents.reduce<DocumentRecord | null>((current, item) => {
        if (!current || item.documentNumber > current.documentNumber) return item;
        return current;
      }, null);
      if (latest) documentNumbers.push(latest.documentNumber);
      else missingRecentDocument = true;
    }
    for (const document of documents) {
      if (textMentionsDocument(text, document)) documentNumbers.push(document.documentNumber);
    }

    const result = emptyNoteLinks();
    result.missingRecentDocument = missingRecentDocument;
    for (const taskNumber of unique(taskNumbers)) {
      const task = await deps.db.findTask(user.id, taskNumber);
      if (!task || task.deletedAt || task.userId !== user.id) {
        if (explicitTasks.has(taskNumber)) result.missingTasks.push(taskNumber);
        continue;
      }
      if (await writeTaskLink(deps, note.id, task.id)) result.createdTasks += 1;
      result.tasks.push(task.taskNumber);
    }
    for (const documentNumber of unique(documentNumbers)) {
      const document = documents.find((item) => item.documentNumber === documentNumber && item.userId === user.id) ?? null;
      if (!document) {
        if (explicitDocuments.has(documentNumber)) result.missingDocuments.push(documentNumber);
        continue;
      }
      if (await writeDocumentLink(deps, note.id, document.id)) result.createdDocuments += 1;
      result.documents.push(document.documentNumber);
    }
    return result;
  } catch (error) {
    deps.logger.warn(
      { event: "note_link_failed", noteId: note.id, message: redactString(error instanceof Error ? error.message : "link failed") },
      "note link failed",
    );
    return emptyNoteLinks();
  }
}

export async function backfillNoteLinks(deps: Pick<Deps, "db" | "logger">): Promise<{ tasks: number; documents: number; failed: number }> {
  const totals = { tasks: 0, documents: 0, failed: 0 };
  const userIds = await deps.db.listUserIds();
  for (const userId of userIds) {
    const user = await deps.db.findUserById(userId);
    if (!user) continue;
    const notes = await deps.db.listNotes(user.id);
    for (const note of notes) {
      try {
        const result = await attachNoteLinks(deps, user, note, { useConversation: false });
        totals.tasks += result.createdTasks;
        totals.documents += result.createdDocuments;
      } catch (error) {
        totals.failed += 1;
        deps.logger.warn(
          { event: "note_link_failed", noteId: note.id, message: redactString(error instanceof Error ? error.message : "link failed") },
          "note link backfill skipped one note",
        );
      }
    }
  }
  deps.logger.info(
    { event: "note_link_backfill", tasks: totals.tasks, documents: totals.documents, failed: totals.failed },
    "note link backfill finished",
  );
  return totals;
}

async function writeTaskLink(deps: Pick<Deps, "db" | "logger">, noteId: string, taskId: string): Promise<boolean> {
  const created = await deps.db.linkNoteTask(noteId, taskId);
  if (created) deps.logger.info({ event: "note_link", kind: "task", noteId, taskId }, "note linked to task");
  return created;
}

async function writeDocumentLink(deps: Pick<Deps, "db" | "logger">, noteId: string, documentId: string): Promise<boolean> {
  const created = await deps.db.linkNoteDocument(noteId, documentId);
  if (created) deps.logger.info({ event: "note_link", kind: "document", noteId, documentId }, "note linked to document");
  return created;
}

async function discussedNumber(deps: Pick<Deps, "db">, userId: string, kind: "task" | "document"): Promise<number | null> {
  const turns = await deps.db.recentTurns(userId, 8);
  const previous = turns.filter((turn) => turn.role === "user").at(-1);
  if (!previous) return null;
  const numbers = kind === "task" ? mentionedRecordNumbers(previous.content).tasks : mentionedRecordNumbers(previous.content).documents;
  return numbers.length === 1 ? numbers[0] ?? null : null;
}

function textMentionsDocument(text: string, document: DocumentRecord): boolean {
  const haystack = text.toLowerCase();
  const title = document.title.trim().toLowerCase();
  const filename = document.originalFilename.trim().toLowerCase();
  if (title.length >= 8 && !GENERIC_TITLES.has(title) && haystack.includes(title)) return true;
  if (filename.length >= 8 && haystack.includes(filename)) return true;
  return false;
}

function unique(values: number[]): number[] {
  return [...new Set(values)];
}
