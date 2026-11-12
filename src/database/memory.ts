import { randomUUID } from "node:crypto";
import { IntentSchema, type Intent } from "../types/intent.js";
import type {
  AdminSession,
  AuditEntry,
  ConversationTurn,
  Delivery,
  DocumentRecord,
  Equipment,
  Memory,
  Extraction,
  KnowledgeEntry,
  Note,
  Reminder,
  Task,
  TaskEvent,
  UsageEntry,
  User,
  UserRole,
} from "../types/models.js";
import { SAVED_TEXT_MIN_SIMILARITY, cosineSimilarity, hybridScore, lexicalSimilarity, trigramWordSimilarity } from "./similarity.js";
import type { ChunkHit, ChunkSource, CompletedTask, Database, MemoryQuery, NewAdminLoginToken, NewAdminSession, NewDocument, NewEquipment, NewKnowledge, NewMemory, NewNote, NewReminder, NewTask, SavedTextHit, StoredChunk, UsageSlice } from "./types.js";

interface Counters {
  task: number;
  reminder: number;
  note: number;
  knowledge: number;
  document: number;
  equipment: number;
  memory: number;
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

function publicSession(session: AdminSession & { sessionHash: string }): AdminSession {
  const { sessionHash: _hash, ...rest } = session;
  return { ...rest };
}

export class MemoryDatabase implements Database {
  private users: User[] = [];
  private counters = new Map<string, Counters>();
  private memories: Memory[] = [];
  private tasks: Task[] = [];
  private events: TaskEvent[] = [];
  private reminders: Reminder[] = [];
  private deliveries: Delivery[] = [];
  private notes: Note[] = [];
  private noteTasks: Array<{ noteId: string; taskId: string }> = [];
  private noteDocuments: Array<{ noteId: string; documentId: string }> = [];
  private knowledge: KnowledgeEntry[] = [];
  private documents: DocumentRecord[] = [];
  private equipment: Equipment[] = [];
  private chunks: Array<StoredChunk & { userId: string }> = [];
  private extractions: Extraction[] = [];
  private updates = new Set<number>();
  private updateLog: Array<{ updateId: number; telegramUserId: number | null; at: string }> = [];
  private confirmations = new Map<string, { action: Intent; expiresAt: string }>();
  private turns: ConversationTurn[] = [];
  private audits: AuditEntry[] = [];
  private usage: UsageEntry[] = [];
  private loginTokens: Array<NewAdminLoginToken & { usedAt: string | null }> = [];
  private sessions: Array<AdminSession & { sessionHash: string }> = [];

  async ping(): Promise<{ ok: boolean; reason: string }> {
    return { ok: true, reason: "memory" };
  }

  private nextCounter(userId: string, kind: keyof Counters): number {
    const current = this.counters.get(userId) ?? { task: 0, reminder: 0, note: 0, knowledge: 0, document: 0, equipment: 0, memory: 0 };
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
      role: "user",
      displayName: input.displayName,
      timezone: input.timezone,
      startedBot: input.startedBot,
      lastNotifiedReminderId: null,
      dailySummaryLocalTime: null,
      createdAt: input.at,
      updatedAt: input.at,
    };
    this.users.push(user);
    this.counters.set(user.id, { task: 0, reminder: 0, note: 0, knowledge: 0, document: 0, equipment: 0, memory: 0 });
    return copy(user);
  }

  async findUserById(id: string): Promise<User | null> {
    return copy(this.users.find((user) => user.id === id) ?? null);
  }

  async setUserRole(userId: string, role: UserRole): Promise<void> {
    const user = this.users.find((item) => item.id === userId);
    if (user) user.role = role;
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

  async listCompletedTasks(userId: string, fromInclusive: string, untilExclusive: string): Promise<CompletedTask[]> {
    return this.events
      .filter(
        (event) =>
          event.userId === userId &&
          event.action === "completed" &&
          event.createdAt >= fromInclusive &&
          event.createdAt < untilExclusive,
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .flatMap((event) => {
        const task = this.tasks.find((item) => item.id === event.taskId);
        if (!task) return [];
        return [{ taskNumber: task.taskNumber, title: task.title, closedAt: event.createdAt }];
      });
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
      snoozedNextRunAt: null,
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

  async findReminderById(id: string): Promise<Reminder | null> {
    return copy(this.reminders.find((reminder) => reminder.id === id) ?? null);
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

  async listUserIds(): Promise<string[]> {
    return this.users.map((user) => user.id);
  }

  async listNotes(userId: string): Promise<Note[]> {
    return this.notes.filter((note) => note.userId === userId && !note.deletedAt).map((note) => copy(note));
  }

  async searchNotes(userId: string, query: string): Promise<Note[]> {
    return this.notes
      .filter((note) => note.userId === userId && !note.deletedAt && matches(query, [note.title, note.content, note.category, note.tags.join(" ")]))
      .map((note) => copy(note));
  }

  async linkNoteTask(noteId: string, taskId: string): Promise<boolean> {
    if (this.noteTasks.some((link) => link.noteId === noteId && link.taskId === taskId)) return false;
    this.noteTasks.push({ noteId, taskId });
    return true;
  }

  async linkNoteDocument(noteId: string, documentId: string): Promise<boolean> {
    if (this.noteDocuments.some((link) => link.noteId === noteId && link.documentId === documentId)) return false;
    this.noteDocuments.push({ noteId, documentId });
    return true;
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

  async renameDocument(userId: string, documentNumber: number, title: string): Promise<DocumentRecord | null> {
    const document = this.documents.find((item) => item.userId === userId && item.documentNumber === documentNumber && !item.deletedAt);
    if (!document) return null;
    document.title = title;
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

  async searchSavedText(userId: string, query: string): Promise<SavedTextHit[]> {
    const needle = query.trim().slice(0, 200);
    if (!needle) return [];
    const hits: SavedTextHit[] = [];
    const consider = (source: SavedTextHit["source"], sourceNumber: number, title: string, body: string) => {
      const haystack = `${title}\n${body}`;
      const similarity = haystack.toLowerCase().includes(needle.toLowerCase()) ? 1 : trigramWordSimilarity(needle, haystack);
      if (similarity < SAVED_TEXT_MIN_SIMILARITY) return;
      hits.push({ source, sourceNumber, title, excerpt: body.slice(0, 500), similarity });
    };
    for (const note of this.notes) {
      if (note.userId === userId && !note.deletedAt) consider("note", note.noteNumber, note.title, note.content);
    }
    for (const entry of this.knowledge) {
      if (entry.userId === userId && !entry.deletedAt) consider("knowledge", entry.entryNumber, entry.title, entry.content);
    }
    for (const document of this.documents) {
      if (document.userId !== userId || document.deletedAt) continue;
      const extraction = this.extractions.find((item) => item.documentId === document.id);
      consider("document", document.documentNumber, document.title, extraction?.text ?? "");
    }
    return hits.sort((left, right) => right.similarity - left.similarity || left.source.localeCompare(right.source)).slice(0, 8);
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

  async insertMemory(input: NewMemory): Promise<Memory> {
    const memory: Memory = {
      id: randomUUID(),
      userId: input.userId,
      memoryNumber: this.nextCounter(input.userId, "memory"),
      content: input.content,
      memoryType: input.memoryType,
      importance: input.importance,
      metadata: { ...input.metadata },
      pinned: input.pinned,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      confidence: input.confidence,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      expiresAt: input.expiresAt,
      deletedAt: null,
    };
    this.memories.push(memory);
    return copy(memory);
  }

  async updateMemory(memory: Memory): Promise<Memory> {
    const index = this.memories.findIndex((item) => item.id === memory.id && item.userId === memory.userId);
    if (index < 0) throw new Error("Memory was not found.");
    this.memories[index] = copy(memory);
    return copy(memory);
  }

  async findMemory(userId: string, memoryNumber: number): Promise<Memory | null> {
    return copy(this.memories.find((memory) => memory.userId === userId && memory.memoryNumber === memoryNumber && !memory.deletedAt) ?? null);
  }

  async listMemories(userId: string, options: MemoryQuery): Promise<Memory[]> {
    return this.memories
      .filter((memory) => this.memoryVisible(memory, userId, options))
      .sort((left, right) => right.memoryNumber - left.memoryNumber)
      .slice(0, options.limit)
      .map((memory) => copy(memory));
  }

  async searchMemories(userId: string, query: string, options: MemoryQuery): Promise<Memory[]> {
    const terms = query.toLowerCase().match(/[a-z0-9]+/g)?.filter((term) => term.length > 1) ?? [];
    return this.memories
      .filter((memory) => {
        if (!this.memoryVisible(memory, userId, options)) return false;
        const haystack = memory.content.toLowerCase();
        return terms.length === 0 || terms.every((term) => haystack.includes(term));
      })
      .sort((left, right) => right.memoryNumber - left.memoryNumber)
      .slice(0, options.limit)
      .map((memory) => copy(memory));
  }

  async deleteExpiredMemories(userId: string, nowIso: string): Promise<number> {
    const now = Date.parse(nowIso);
    let count = 0;
    for (const memory of this.memories) {
      if (memory.userId !== userId || memory.deletedAt || !memory.expiresAt) continue;
      if (Date.parse(memory.expiresAt) > now) continue;
      memory.deletedAt = nowIso;
      memory.updatedAt = nowIso;
      count += 1;
    }
    return count;
  }

  private memoryVisible(memory: Memory, userId: string, options: MemoryQuery): boolean {
    if (memory.userId !== userId || memory.deletedAt) return false;
    if (options.memoryType && memory.memoryType !== options.memoryType) return false;
    if (options.includeExpired) return true;
    return !memory.expiresAt || Date.parse(memory.expiresAt) > Date.parse(options.nowIso);
  }

  async insertEquipment(input: NewEquipment): Promise<Equipment> {
    const item: Equipment = {
      id: randomUUID(),
      equipmentNumber: this.nextCounter(input.userId, "equipment"),
      deletedAt: null,
      updatedAt: input.createdAt,
      ...input,
    };
    this.equipment.push(item);
    return copy(item);
  }

  async updateEquipment(item: Equipment): Promise<Equipment> {
    const index = this.equipment.findIndex((entry) => entry.id === item.id);
    if (index < 0) throw new Error("Equipment not found");
    this.equipment[index] = copy(item);
    return copy(item);
  }

  async listEquipment(userId: string): Promise<Equipment[]> {
    return this.equipment.filter((item) => item.userId === userId && !item.deletedAt).map((item) => copy(item));
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

  async listAudit(userId: string, limit: number): Promise<AuditEntry[]> {
    return this.audits
      .filter((entry) => entry.userId === userId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map((entry) => copy(entry));
  }

  async insertAdminLoginToken(input: NewAdminLoginToken): Promise<void> {
    if (this.loginTokens.some((token) => token.tokenHash === input.tokenHash)) throw new Error("Duplicate login token.");
    this.loginTokens.push({ ...input, usedAt: null });
  }

  async consumeAdminLoginToken(tokenHash: string, nowIso: string): Promise<string | null> {
    const token = this.loginTokens.find((item) => item.tokenHash === tokenHash);
    if (!token || token.usedAt || Date.parse(token.expiresAt) <= Date.parse(nowIso)) return null;
    token.usedAt = nowIso;
    return token.userId;
  }

  async insertAdminSession(input: NewAdminSession): Promise<AdminSession> {
    const session = {
      id: randomUUID(),
      userId: input.userId,
      sessionHash: input.sessionHash,
      userAgent: input.userAgent,
      createdAt: input.createdAt,
      lastSeenAt: input.createdAt,
      expiresAt: input.expiresAt,
      revokedAt: null,
    };
    this.sessions.push(session);
    return publicSession(session);
  }

  async findAdminSession(sessionHash: string, nowIso: string): Promise<AdminSession | null> {
    const session = this.sessions.find((item) => item.sessionHash === sessionHash);
    if (!session || session.revokedAt || Date.parse(session.expiresAt) <= Date.parse(nowIso)) return null;
    return publicSession(session);
  }

  async touchAdminSession(sessionId: string, lastSeenAt: string, expiresAt: string): Promise<void> {
    const session = this.sessions.find((item) => item.id === sessionId);
    if (!session) return;
    session.lastSeenAt = lastSeenAt;
    session.expiresAt = expiresAt;
  }

  async revokeAdminSession(sessionId: string, userId: string, nowIso: string): Promise<void> {
    const session = this.sessions.find((item) => item.id === sessionId && item.userId === userId);
    if (session && !session.revokedAt) session.revokedAt = nowIso;
  }

  async recordUsage(entry: Omit<UsageEntry, "id">): Promise<void> {
    this.usage.push({ ...entry, id: randomUUID() });
  }

  async replaceChunks(userId: string, source: ChunkSource, sourceId: string, chunks: StoredChunk[]): Promise<void> {
    this.chunks = this.chunks.filter((chunk) => !(chunk.userId === userId && chunk.source === source && chunk.sourceId === sourceId));
    for (const chunk of chunks) this.chunks.push({ ...chunk, userId });
  }

  async listChunks(userId: string, source: ChunkSource, sourceId: string): Promise<StoredChunk[]> {
    return this.chunks
      .filter((chunk) => chunk.userId === userId && chunk.source === source && chunk.sourceId === sourceId)
      .map((chunk) => ({
        source: chunk.source,
        sourceId: chunk.sourceId,
        sourceNumber: chunk.sourceNumber,
        title: chunk.title,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        chunkType: chunk.chunkType,
        embedding: null,
        embeddingModel: chunk.embeddingModel,
        metadata: { chunk_type: chunk.chunkType, embedding_model: chunk.embeddingModel },
      }))
      .sort((left, right) => left.chunkIndex - right.chunkIndex);
  }

  async searchChunks(userId: string, query: string, embedding: number[] | null, embeddingModel: string | null, limit: number): Promise<ChunkHit[]> {
    const q = query.trim().slice(0, 200);
    if (!q) return [];
    return this.chunks
      .filter((chunk) => chunk.userId === userId)
      .map((chunk) => {
        const lexical = Math.max(
          chunk.title.toLowerCase().includes(q.toLowerCase()) || chunk.content.toLowerCase().includes(q.toLowerCase()) ? 1 : 0,
          lexicalSimilarity(q, `${chunk.title} ${chunk.content}`),
        );
        const sameModel = !chunk.embeddingModel || !embeddingModel || chunk.embeddingModel === embeddingModel;
        const hasVector = !!embedding && !!chunk.embedding && sameModel;
        const vectorScore = hasVector && embedding && chunk.embedding ? Math.max(0, cosineSimilarity(embedding, chunk.embedding)) : 0;
        const score = hybridScore(lexical, vectorScore, hasVector);
        return {
          source: chunk.source,
          sourceId: chunk.sourceId,
          sourceNumber: chunk.sourceNumber,
          title: chunk.title,
          content: chunk.content,
          chunkType: chunk.chunkType,
          lexical,
          vectorScore,
          score,
          metadata: { chunk_type: chunk.chunkType, embedding_model: chunk.embeddingModel },
        };
      })
      .filter((hit) => hit.lexical >= SAVED_TEXT_MIN_SIMILARITY || hit.vectorScore >= 0.45 || hit.score >= SAVED_TEXT_MIN_SIMILARITY)
      .sort((left, right) => right.score - left.score || left.source.localeCompare(right.source) || left.sourceNumber - right.sourceNumber)
      .slice(0, Math.min(Math.max(limit, 1), 16));
  }

  async listUsage(userId: string, fromInclusive: string, untilExclusive: string): Promise<UsageSlice[]> {
    const from = Date.parse(fromInclusive);
    const until = Date.parse(untilExclusive);
    return this.usage
      .filter((entry) => entry.userId === userId && Date.parse(entry.createdAt) >= from && Date.parse(entry.createdAt) < until)
      .map((entry) => ({ model: entry.model, inputTokens: entry.inputTokens, outputTokens: entry.outputTokens }));
  }
}

export function createMemoryDatabase(): Database {
  return new MemoryDatabase();
}
