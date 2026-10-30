import { randomUUID } from "node:crypto";
import { IntentSchema, type Intent } from "../types/intent.js";
import type {
  AuditEntry,
  ConversationTurn,
  Delivery,
  DocumentRecord,
  Extraction,
  KnowledgeEntry,
  Note,
  Reminder,
  Task,
  TaskEvent,
  UsageEntry,
  User,
} from "../types/models.js";
import type { Database, NewDocument, NewKnowledge, NewNote, NewReminder, NewTask } from "./types.js";

interface Counters {
  task: number;
  reminder: number;
  note: number;
  knowledge: number;
  document: number;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function matches(query: string, parts: Array<string | null | undefined>): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter((token) => token.length > 1);
  if (tokens.length === 0) return false;
  const haystack = parts.filter(Boolean).join(" ").toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

function timeMs(iso: string): number {
  const value = Date.parse(iso);
  return Number.isNaN(value) ? 0 : value;
}

export class MemoryDatabase implements Database {
  private users: User[] = [];
  private counters = new Map<string, Counters>();
  private tasks: Task[] = [];
  private events: TaskEvent[] = [];
  private reminders: Reminder[] = [];
  private deliveries: Delivery[] = [];
  private notes: Note[] = [];
  private noteTasks: Array<{ noteId: string; taskId: string }> = [];
  private noteDocuments: Array<{ noteId: string; documentId: string }> = [];
  private knowledge: KnowledgeEntry[] = [];
  private documents: DocumentRecord[] = [];
  private extractions: Extraction[] = [];
  private updates = new Set<number>();
  private updateLog: Array<{ updateId: number; telegramUserId: number | null; at: string }> = [];
  private confirmations = new Map<string, { action: Intent; expiresAt: string }>();
  private turns: ConversationTurn[] = [];
  private audits: AuditEntry[] = [];
  private usage: UsageEntry[] = [];

  async ping(): Promise<{ ok: boolean; reason: string }> {
    return { ok: true, reason: "memory" };
  }

  private nextCounter(userId: string, kind: keyof Counters): number {
    const current = this.counters.get(userId) ?? { task: 0, reminder: 0, note: 0, knowledge: 0, document: 0 };
    current[kind] += 1;
    this.counters.set(userId, current);
    return current[kind];
  }

  async upsertFromTelegram(input: {
    telegramUserId: number;
    displayName: string | null;
    timezone: string;
    startedBot: boolean;
    at: string;
  }): Promise<User> {
    const existing = this.users.find((user) => user.telegramUserId === input.telegramUserId);
    if (existing) {
      existing.displayName = input.displayName;
      existing.startedBot = existing.startedBot || input.startedBot;
      existing.updatedAt = input.at;
      return copy(existing);
    }
    const user: User = {
      id: randomUUID(),
      telegramUserId: input.telegramUserId,
      displayName: input.displayName,
      timezone: input.timezone,
      startedBot: input.startedBot,
      lastNotifiedReminderId: null,
      dailySummaryLocalTime: null,
      createdAt: input.at,
      updatedAt: input.at,
    };
    this.users.push(user);
    this.counters.set(user.id, { task: 0, reminder: 0, note: 0, knowledge: 0, document: 0 });
    return copy(user);
  }

  async findUserById(id: string): Promise<User | null> {
    return copy(this.users.find((user) => user.id === id) ?? null);
  }

  async setLastNotifiedReminder(userId: string, reminderId: string | null, at: string): Promise<void> {
    const user = this.users.find((item) => item.id === userId);
    if (!user) return;
    user.lastNotifiedReminderId = reminderId;
    user.updatedAt = at;
  }

  async setDailySummaryTime(userId: string, time: string | null, at: string): Promise<void> {
    const user = this.users.find((item) => item.id === userId);
    if (!user) return;
    user.dailySummaryLocalTime = time;
    user.updatedAt = at;
  }

  async insertTask(input: NewTask): Promise<Task> {
    const task: Task = {
      id: randomUUID(),
      userId: input.userId,
      taskNumber: this.nextCounter(input.userId, "task"),
      title: input.title,
      description: input.description,
      category: input.category,
      priority: input.priority,
      status: input.status,
      dueAt: input.dueAt,
      completedAt: null,
      tags: input.tags,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      deletedAt: null,
    };
    this.tasks.push(task);
    return copy(task);
  }

  async updateTask(task: Task): Promise<Task> {
    const index = this.tasks.findIndex((item) => item.id === task.id);
    if (index < 0) throw new Error("Task not found");
    this.tasks[index] = copy(task);
    return copy(task);
  }

  async findTask(userId: string, taskNumber: number): Promise<Task | null> {
    return copy(this.tasks.find((task) => task.userId === userId && task.taskNumber === taskNumber) ?? null);
  }

  async listTasks(userId: string): Promise<Task[]> {
    return this.tasks.filter((task) => task.userId === userId && !task.deletedAt).map((task) => copy(task));
  }

  async searchTasks(userId: string, query: string): Promise<Task[]> {
    return this.tasks
      .filter((task) => task.userId === userId && !task.deletedAt && matches(query, [task.title, task.description, task.category, task.tags.join(" ")]))
      .map((task) => copy(task));
  }

  async addTaskEvent(event: Omit<TaskEvent, "id">): Promise<void> {
    this.events.push({ ...event, id: randomUUID() });
  }

  async listTaskEvents(userId: string, taskNumber: number): Promise<TaskEvent[]> {
    const task = this.tasks.find((item) => item.userId === userId && item.taskNumber === taskNumber);
    if (!task) return [];
    return this.events.filter((event) => event.taskId === task.id).map((event) => copy(event));
  }

  async insertReminder(input: NewReminder): Promise<{ reminder: Reminder; created: boolean }> {
    const existing = this.reminders.find(
      (reminder) => reminder.userId === input.userId && reminder.status === "active" && reminder.dedupeKey === input.dedupeKey,
    );
    if (existing) return { reminder: copy(existing), created: false };
    const reminder: Reminder = {
      ...input,
      id: randomUUID(),
      reminderNumber: this.nextCounter(input.userId, "reminder"),
      attemptOccurrenceAt: null,
      lockedUntil: null,
      lockToken: null,
      lastError: null,
      updatedAt: input.createdAt,
    };
    this.reminders.push(reminder);
    return { reminder: copy(reminder), created: true };
  }

  async updateReminder(reminder: Reminder): Promise<Reminder> {
    const index = this.reminders.findIndex((item) => item.id === reminder.id);
    if (index < 0) throw new Error("Reminder not found");
    this.reminders[index] = copy(reminder);
    return copy(reminder);
  }

  async findReminder(userId: string, reminderNumber: number): Promise<Reminder | null> {
    return copy(this.reminders.find((reminder) => reminder.userId === userId && reminder.reminderNumber === reminderNumber) ?? null);
  }

  async listReminders(userId: string): Promise<Reminder[]> {
    return this.reminders.filter((reminder) => reminder.userId === userId).map((reminder) => copy(reminder));
  }

  async claimDueReminders(worker: string, limit: number, lockSeconds: number, nowIso: string): Promise<Reminder[]> {
    const now = timeMs(nowIso);
    const due = this.reminders
      .filter((reminder) => {
        if (reminder.status !== "active") return false;
        if (timeMs(reminder.nextRunAt) > now) return false;
        if (reminder.lockedUntil && timeMs(reminder.lockedUntil) >= now) return false;
        return true;
      })
      .sort((left, right) => timeMs(left.nextRunAt) - timeMs(right.nextRunAt))
      .slice(0, limit);
    const until = new Date(now + lockSeconds * 1000).toISOString();
    for (const reminder of due) {
      reminder.lockedUntil = until;
      reminder.lockToken = worker;
      reminder.updatedAt = nowIso;
    }
    return due.map((reminder) => copy(reminder));
  }

  async startDelivery(reminderId: string, occurrenceAt: string, nowIso: string): Promise<{ action: "send" | "skip"; attempt: number }> {
    const existing = this.deliveries.find((delivery) => delivery.reminderId === reminderId && delivery.occurrenceAt === occurrenceAt);
    if (!existing) {
      this.deliveries.push({
        id: randomUUID(),
        reminderId,
        occurrenceAt,
        status: "pending",
        error: null,
        attempt: 1,
        telegramMessageId: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      return { action: "send", attempt: 1 };
    }
    if (existing.status === "sent") return { action: "skip", attempt: existing.attempt };
    existing.attempt += 1;
    existing.status = "pending";
    existing.updatedAt = nowIso;
    return { action: "send", attempt: existing.attempt };
  }

  async finishDelivery(
    reminderId: string,
    occurrenceAt: string,
    status: "sent" | "failed",
    error: string | null,
    messageId: number | null,
    nowIso: string,
  ): Promise<void> {
    const existing = this.deliveries.find((delivery) => delivery.reminderId === reminderId && delivery.occurrenceAt === occurrenceAt);
    if (!existing) return;
    existing.status = status;
    existing.error = error;
    existing.telegramMessageId = messageId;
    existing.updatedAt = nowIso;
  }

  async insertNote(input: NewNote): Promise<Note> {
    const note: Note = {
      id: randomUUID(),
      noteNumber: this.nextCounter(input.userId, "note"),
      deletedAt: null,
      updatedAt: input.createdAt,
      ...input,
    };
    this.notes.push(note);
    return copy(note);
  }

  async updateNote(note: Note): Promise<Note> {
    const index = this.notes.findIndex((item) => item.id === note.id);
    if (index < 0) throw new Error("Note not found");
    this.notes[index] = copy(note);
    return copy(note);
  }

  async findNote(userId: string, noteNumber: number): Promise<Note | null> {
    return copy(this.notes.find((note) => note.userId === userId && note.noteNumber === noteNumber) ?? null);
  }

  async listNotes(userId: string): Promise<Note[]> {
    return this.notes.filter((note) => note.userId === userId && !note.deletedAt).map((note) => copy(note));
  }

  async searchNotes(userId: string, query: string): Promise<Note[]> {
    return this.notes
      .filter((note) => note.userId === userId && !note.deletedAt && matches(query, [note.title, note.content, note.category, note.tags.join(" ")]))
      .map((note) => copy(note));
  }

  async linkNoteTask(noteId: string, taskId: string): Promise<void> {
    if (!this.noteTasks.some((link) => link.noteId === noteId && link.taskId === taskId)) {
      this.noteTasks.push({ noteId, taskId });
    }
  }

  async linkNoteDocument(noteId: string, documentId: string): Promise<void> {
    if (!this.noteDocuments.some((link) => link.noteId === noteId && link.documentId === documentId)) {
      this.noteDocuments.push({ noteId, documentId });
    }
  }

  async insertKnowledge(input: NewKnowledge): Promise<KnowledgeEntry> {
    const entry: KnowledgeEntry = {
      id: randomUUID(),
      entryNumber: this.nextCounter(input.userId, "knowledge"),
      deletedAt: null,
      updatedAt: input.createdAt,
      ...input,
    };
    this.knowledge.push(entry);
    return copy(entry);
  }

  async listKnowledge(userId: string): Promise<KnowledgeEntry[]> {
    return this.knowledge.filter((entry) => entry.userId === userId && !entry.deletedAt).map((entry) => copy(entry));
  }

  async searchKnowledge(userId: string, query: string): Promise<KnowledgeEntry[]> {
    return this.knowledge
      .filter((entry) => entry.userId === userId && !entry.deletedAt && matches(query, [entry.title, entry.content, entry.category, entry.tags.join(" ")]))
      .map((entry) => copy(entry));
  }

  async insertDocument(input: NewDocument): Promise<DocumentRecord> {
    const document: DocumentRecord = {
      documentNumber: this.nextCounter(input.userId, "document"),
      deletedAt: null,
      ...input,
    };
    this.documents.push(document);
    return copy(document);
  }

  async findDocument(userId: string, documentNumber: number): Promise<DocumentRecord | null> {
    return copy(this.documents.find((document) => document.userId === userId && document.documentNumber === documentNumber && !document.deletedAt) ?? null);
  }

  async findDocumentByHash(userId: string, sha256: string): Promise<DocumentRecord | null> {
    return copy(this.documents.find((document) => document.userId === userId && document.sha256 === sha256 && !document.deletedAt) ?? null);
  }

  async listDocuments(userId: string): Promise<DocumentRecord[]> {
    return this.documents.filter((document) => document.userId === userId && !document.deletedAt).map((document) => copy(document));
  }

  async searchDocuments(userId: string, query: string): Promise<DocumentRecord[]> {
    return this.documents
      .filter((document) => {
        if (document.userId !== userId || document.deletedAt) return false;
        const extraction = this.extractions.find((item) => item.documentId === document.id);
        return matches(query, [document.title, document.originalFilename, document.category, extraction?.text]);
      })
      .map((document) => copy(document));
  }

  async saveExtraction(extraction: Extraction): Promise<void> {
    const index = this.extractions.findIndex((item) => item.documentId === extraction.documentId);
    if (index >= 0) this.extractions[index] = copy(extraction);
    else this.extractions.push(copy(extraction));
  }

  async getExtraction(documentId: string): Promise<Extraction | null> {
    return copy(this.extractions.find((item) => item.documentId === documentId) ?? null);
  }

  async claimUpdate(updateId: number, telegramUserId: number | null, at: string): Promise<boolean> {
    if (this.updates.has(updateId)) return false;
    this.updates.add(updateId);
    this.updateLog.push({ updateId, telegramUserId, at });
    return true;
  }

  async putConfirmation(userId: string, action: Intent, expiresAt: string): Promise<void> {
    this.confirmations.set(userId, { action: copy(action), expiresAt });
  }

  async getConfirmation(userId: string): Promise<{ action: Intent; expiresAt: string } | null> {
    const found = this.confirmations.get(userId);
    if (!found) return null;
    const parsed = IntentSchema.safeParse(found.action);
    if (!parsed.success) {
      this.confirmations.delete(userId);
      return null;
    }
    return { action: parsed.data, expiresAt: found.expiresAt };
  }

  async clearConfirmation(userId: string): Promise<void> {
    this.confirmations.delete(userId);
  }

  async appendTurn(userId: string, role: "user" | "assistant", content: string, at: string): Promise<void> {
    this.turns.push({ id: randomUUID(), userId, role, content: content.slice(0, 2000), createdAt: at });
    const mine = this.turns.filter((turn) => turn.userId === userId);
    if (mine.length > 30) {
      const remove = new Set(mine.slice(0, mine.length - 30).map((turn) => turn.id));
      this.turns = this.turns.filter((turn) => !remove.has(turn.id));
    }
  }

  async recentTurns(userId: string, limit: number): Promise<ConversationTurn[]> {
    return this.turns.filter((turn) => turn.userId === userId).slice(-limit).map((turn) => copy(turn));
  }

  async writeAudit(entry: Omit<AuditEntry, "id">): Promise<void> {
    this.audits.push({ ...entry, id: randomUUID() });
  }

  async recordUsage(entry: Omit<UsageEntry, "id">): Promise<void> {
    this.usage.push({ ...entry, id: randomUUID() });
  }
}

export function createMemoryDatabase(): Database {
  return new MemoryDatabase();
}
