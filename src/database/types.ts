import type { Intent } from "../types/intent.js";
import type {
  AdminSession,
  AuditEntry,
  ConversationTurn,
  DocumentRecord,
  Equipment,
  Memory,
  MemorySourceType,
  MemoryType,
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
  UserRole,
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

export interface NewMemory {
  userId: string;
  content: string;
  memoryType: MemoryType;
  importance: number | null;
  metadata: Record<string, string | number | boolean | null>;
  pinned: boolean;
  sourceType: MemorySourceType | null;
  sourceId: string | null;
  confidence: number | null;
  createdAt: string;
  expiresAt: string | null;
}

export interface MemoryQuery {
  limit: number;
  memoryType?: MemoryType | null;
  includeExpired?: boolean;
  nowIso: string;
}

export interface NewEquipment {
  userId: string;
  name: string;
  kind: Equipment["kind"];
  location: string;
  ipAddress: string;
  notes: string;
  sourceNoteId: string | null;
  sourceDocumentId: string | null;
  createdAt: string;
}

export interface CompletedTask {
  taskNumber: number;
  title: string;
  closedAt: string;
}

/** One ai_usage row. Cost is computed later so each request keeps its own model price. */
export type ChunkSource = "note" | "knowledge" | "document";
export type ChunkType = "narrative" | "identifier";

export interface ChunkMetadata {
  chunk_type: ChunkType;
  embedding_model: string | null;
}

export interface StoredChunk {
  source: ChunkSource;
  sourceId: string;
  sourceNumber: number;
  title: string;
  chunkIndex: number;
  chunkType: ChunkType;
  content: string;
  embedding: number[] | null;
  embeddingModel: string | null;
  metadata: ChunkMetadata;
}

export interface ChunkHit {
  source: ChunkSource;
  sourceId: string;
  sourceNumber: number;
  title: string;
  content: string;
  chunkType: ChunkType;
  lexical: number;
  vectorScore: number;
  score: number;
  metadata: ChunkMetadata;
}

export interface UsageSlice {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface UsageEventRow {
  model: string;
  purpose: string;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
  createdAt: string;
}

export interface SavedTextHit {
  source: "note" | "knowledge" | "document";
  sourceNumber: number;
  title: string;
  excerpt: string;
  similarity: number;
}

export interface NewAdminLoginToken {
  userId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
}

export interface NewAdminSession {
  userId: string;
  sessionHash: string;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string;
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
  setUserRole(userId: string, role: UserRole): Promise<void>;
  setLastNotifiedReminder(userId: string, reminderId: string | null, at: string): Promise<void>;
  setDailySummaryTime(userId: string, time: string | null, at: string): Promise<void>;
  insertTask(input: NewTask): Promise<Task>;
  updateTask(task: Task): Promise<Task>;
  findTask(userId: string, taskNumber: number): Promise<Task | null>;
  listTasks(userId: string): Promise<Task[]>;
  searchTasks(userId: string, query: string): Promise<Task[]>;
  addTaskEvent(event: Omit<TaskEvent, "id">): Promise<void>;
  listTaskEvents(userId: string, taskNumber: number): Promise<TaskEvent[]>;
  /**
   * Completed events in [fromInclusive, untilExclusive), oldest first.
   * Callers pass the user's local midnight and the next local midnight.
   */
  listCompletedTasks(userId: string, fromInclusive: string, untilExclusive: string): Promise<CompletedTask[]>;
  insertReminder(input: NewReminder): Promise<{ reminder: Reminder; created: boolean }>;
  updateReminder(reminder: Reminder): Promise<Reminder>;
  findReminder(userId: string, reminderNumber: number): Promise<Reminder | null>;
  findReminderById(id: string): Promise<Reminder | null>;
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
  listUserIds(): Promise<string[]>;
  searchNotes(userId: string, query: string): Promise<Note[]>;
  /** Inserts the pair. Returns false when that pair is already stored. */
  linkNoteTask(noteId: string, taskId: string): Promise<boolean>;
  /** Inserts the pair. Returns false when that pair is already stored. */
  linkNoteDocument(noteId: string, documentId: string): Promise<boolean>;
  insertKnowledge(input: NewKnowledge): Promise<KnowledgeEntry>;
  updateKnowledge(entry: KnowledgeEntry): Promise<KnowledgeEntry>;
  findKnowledge(userId: string, entryNumber: number): Promise<KnowledgeEntry | null>;
  listKnowledge(userId: string): Promise<KnowledgeEntry[]>;
  searchKnowledge(userId: string, query: string): Promise<KnowledgeEntry[]>;
  insertDocument(input: NewDocument): Promise<DocumentRecord>;
  renameDocument(userId: string, documentNumber: number, title: string): Promise<DocumentRecord | null>;
  findDocument(userId: string, documentNumber: number): Promise<DocumentRecord | null>;
  findDocumentByHash(userId: string, sha256: string): Promise<DocumentRecord | null>;
  listDocuments(userId: string): Promise<DocumentRecord[]>;
  searchDocuments(userId: string, query: string): Promise<DocumentRecord[]>;
  searchSavedText(userId: string, query: string): Promise<SavedTextHit[]>;
  insertMemory(input: NewMemory): Promise<Memory>;
  updateMemory(memory: Memory): Promise<Memory>;
  findMemory(userId: string, memoryNumber: number): Promise<Memory | null>;
  listMemories(userId: string, options: MemoryQuery): Promise<Memory[]>;
  searchMemories(userId: string, query: string, options: MemoryQuery): Promise<Memory[]>;
  /** Marks memories whose expires_at has passed. Safe to run more than once. */
  deleteExpiredMemories(userId: string, nowIso: string): Promise<number>;
  insertEquipment(input: NewEquipment): Promise<Equipment>;
  updateEquipment(item: Equipment): Promise<Equipment>;
  listEquipment(userId: string): Promise<Equipment[]>;
  saveExtraction(extraction: Extraction): Promise<void>;
  getExtraction(documentId: string): Promise<Extraction | null>;
  claimUpdate(updateId: number, telegramUserId: number | null, at: string): Promise<boolean>;
  putConfirmation(userId: string, action: Intent, expiresAt: string): Promise<void>;
  getConfirmation(userId: string): Promise<{ action: Intent; expiresAt: string } | null>;
  clearConfirmation(userId: string): Promise<void>;
  appendTurn(userId: string, role: "user" | "assistant", content: string, at: string): Promise<void>;
  recentTurns(userId: string, limit: number): Promise<ConversationTurn[]>;
  writeAudit(entry: Omit<AuditEntry, "id">): Promise<void>;
  /** Newest first. */
  listAudit(userId: string, limit: number): Promise<AuditEntry[]>;
  insertAdminLoginToken(input: NewAdminLoginToken): Promise<void>;
  /** Marks an unused, unexpired token as used in one statement. Returns its user id, or null. */
  consumeAdminLoginToken(tokenHash: string, nowIso: string): Promise<string | null>;
  insertAdminSession(input: NewAdminSession): Promise<AdminSession>;
  /** An unrevoked session whose expires_at is after nowIso. */
  findAdminSession(sessionHash: string, nowIso: string): Promise<AdminSession | null>;
  touchAdminSession(sessionId: string, lastSeenAt: string, expiresAt: string): Promise<void>;
  revokeAdminSession(sessionId: string, userId: string, nowIso: string): Promise<void>;
  recordUsage(entry: Omit<UsageEntry, "id">): Promise<void>;
  /** Usage in [fromInclusive, untilExclusive). One entry per stored request. */
  listUsage(userId: string, fromInclusive: string, untilExclusive: string): Promise<UsageSlice[]>;
  listUsageEvents(userId: string, fromInclusive: string, untilExclusive: string): Promise<UsageEventRow[]>;
  replaceChunks(userId: string, source: ChunkSource, sourceId: string, chunks: StoredChunk[]): Promise<void>;
  listChunks(userId: string, source: ChunkSource, sourceId: string): Promise<StoredChunk[]>;
  searchChunks(userId: string, query: string, embedding: number[] | null, embeddingModel: string | null, limit: number): Promise<ChunkHit[]>;
}
