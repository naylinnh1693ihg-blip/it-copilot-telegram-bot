import type { Intent } from "../types/intent.js";
import type {
  AuditEntry,
  ConversationTurn,
  DocumentRecord,
  Extraction,
  KnowledgeEntry,
  Note,
  Priority,
  Reminder,
  ReminderKind,
  ReminderStatus,
  Task,
  TaskEvent,
  TaskStatus,
  UsageEntry,
  User,
} from "../types/models.js";

export interface NewTask {
  userId: string;
  title: string;
  description: string;
  category: string;
  priority: Priority;
  status: TaskStatus;
  dueAt: string | null;
  tags: string[];
  createdAt: string;
}

export interface NewReminder {
  userId: string;
  title: string;
  message: string;
  kind: ReminderKind;
  timezone: string;
  nextRunAt: string;
  weekdays: number[];
  intervalMinutes: number | null;
  status: ReminderStatus;
  dedupeKey: string;
  createdAt: string;
}

export interface NewNote {
  userId: string;
  title: string;
  content: string;
  category: string;
  tags: string[];
  createdAt: string;
}

export interface NewKnowledge {
  userId: string;
  title: string;
  content: string;
  category: string;
  tags: string[];
  createdAt: string;
}

export interface NewDocument {
  id: string;
  userId: string;
  title: string;
  originalFilename: string;
  storagePath: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  category: string;
  tags: string[];
  createdAt: string;
}

export interface Database {
  ping(): Promise<{ ok: boolean; reason: string }>;
  upsertFromTelegram(input: {
    telegramUserId: number;
    displayName: string | null;
    timezone: string;
    startedBot: boolean;
    at: string;
  }): Promise<User>;
  findUserById(id: string): Promise<User | null>;
  setLastNotifiedReminder(userId: string, reminderId: string | null, at: string): Promise<void>;
  setDailySummaryTime(userId: string, time: string | null, at: string): Promise<void>;
  insertTask(input: NewTask): Promise<Task>;
  updateTask(task: Task): Promise<Task>;
  findTask(userId: string, taskNumber: number): Promise<Task | null>;
  listTasks(userId: string): Promise<Task[]>;
  searchTasks(userId: string, query: string): Promise<Task[]>;
  addTaskEvent(event: Omit<TaskEvent, "id">): Promise<void>;
  listTaskEvents(userId: string, taskNumber: number): Promise<TaskEvent[]>;
  insertReminder(input: NewReminder): Promise<{ reminder: Reminder; created: boolean }>;
  updateReminder(reminder: Reminder): Promise<Reminder>;
  findReminder(userId: string, reminderNumber: number): Promise<Reminder | null>;
  listReminders(userId: string): Promise<Reminder[]>;
  claimDueReminders(worker: string, limit: number, lockSeconds: number, nowIso: string): Promise<Reminder[]>;
  startDelivery(reminderId: string, occurrenceAt: string, nowIso: string): Promise<{ action: "send" | "skip"; attempt: number }>;
  finishDelivery(
    reminderId: string,
    occurrenceAt: string,
    status: "sent" | "failed",
    error: string | null,
    messageId: number | null,
    nowIso: string,
  ): Promise<void>;
  insertNote(input: NewNote): Promise<Note>;
  updateNote(note: Note): Promise<Note>;
  findNote(userId: string, noteNumber: number): Promise<Note | null>;
  listNotes(userId: string): Promise<Note[]>;
  searchNotes(userId: string, query: string): Promise<Note[]>;
  linkNoteTask(noteId: string, taskId: string): Promise<void>;
  linkNoteDocument(noteId: string, documentId: string): Promise<void>;
  insertKnowledge(input: NewKnowledge): Promise<KnowledgeEntry>;
  listKnowledge(userId: string): Promise<KnowledgeEntry[]>;
  searchKnowledge(userId: string, query: string): Promise<KnowledgeEntry[]>;
  insertDocument(input: NewDocument): Promise<DocumentRecord>;
  renameDocument(userId: string, documentNumber: number, title: string): Promise<DocumentRecord | null>;
  findDocument(userId: string, documentNumber: number): Promise<DocumentRecord | null>;
  findDocumentByHash(userId: string, sha256: string): Promise<DocumentRecord | null>;
  listDocuments(userId: string): Promise<DocumentRecord[]>;
  searchDocuments(userId: string, query: string): Promise<DocumentRecord[]>;
  saveExtraction(extraction: Extraction): Promise<void>;
  getExtraction(documentId: string): Promise<Extraction | null>;
  claimUpdate(updateId: number, telegramUserId: number | null, at: string): Promise<boolean>;
  putConfirmation(userId: string, action: Intent, expiresAt: string): Promise<void>;
  getConfirmation(userId: string): Promise<{ action: Intent; expiresAt: string } | null>;
  clearConfirmation(userId: string): Promise<void>;
  appendTurn(userId: string, role: "user" | "assistant", content: string, at: string): Promise<void>;
  recentTurns(userId: string, limit: number): Promise<ConversationTurn[]>;
  writeAudit(entry: Omit<AuditEntry, "id">): Promise<void>;
  recordUsage(entry: Omit<UsageEntry, "id">): Promise<void>;
}
