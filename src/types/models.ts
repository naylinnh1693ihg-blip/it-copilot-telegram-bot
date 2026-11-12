export type TaskStatus = "pending" | "in_progress" | "completed" | "cancelled";
export type Priority = "low" | "normal" | "high" | "urgent";
export type ReminderKind = "once" | "daily" | "weekly" | "interval" | "daily_summary";
export type ReminderStatus = "active" | "completed" | "cancelled" | "failed";

/** owner: TELEGRAM_OWNER_ID. admin: may use the admin app. user: bot only. */
export type UserRole = "owner" | "admin" | "user";

export interface User {
  id: string;
  telegramUserId: number;
  role: UserRole;
  displayName: string | null;
  timezone: string;
  startedBot: boolean;
  lastNotifiedReminderId: string | null;
  dailySummaryLocalTime: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  userId: string;
  taskNumber: number;
  title: string;
  description: string;
  category: string;
  priority: Priority;
  status: TaskStatus;
  dueAt: string | null;
  completedAt: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  userId: string;
  action: string;
  summary: string;
  createdAt: string;
}

export interface Reminder {
  id: string;
  userId: string;
  reminderNumber: number;
  title: string;
  message: string;
  kind: ReminderKind;
  timezone: string;
  nextRunAt: string;
  weekdays: number[];
  intervalMinutes: number | null;
  status: ReminderStatus;
  dedupeKey: string;
  attemptOccurrenceAt: string | null;
  snoozedNextRunAt: string | null;
  lockedUntil: string | null;
  lockToken: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Delivery {
  id: string;
  reminderId: string;
  occurrenceAt: string;
  status: "pending" | "sent" | "failed";
  error: string | null;
  attempt: number;
  telegramMessageId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface Note {
  id: string;
  userId: string;
  noteNumber: number;
  title: string;
  content: string;
  category: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface KnowledgeEntry {
  id: string;
  userId: string;
  entryNumber: number;
  title: string;
  content: string;
  category: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface DocumentRecord {
  id: string;
  userId: string;
  documentNumber: number;
  title: string;
  originalFilename: string;
  storagePath: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  category: string;
  tags: string[];
  createdAt: string;
  deletedAt: string | null;
}

export type EquipmentKind = "printer" | "switch" | "access_point" | "other";

export interface Equipment {
  id: string;
  userId: string;
  equipmentNumber: number;
  name: string;
  kind: EquipmentKind;
  location: string;
  ipAddress: string;
  notes: string;
  sourceNoteId: string | null;
  sourceDocumentId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface Extraction {
  documentId: string;
  text: string;
  truncated: boolean;
  extractedAt: string;
}

export interface ConversationTurn {
  id: string;
  userId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export type MemoryType = "preference" | "fact" | "context" | "equipment" | "goal";

export const MEMORY_TYPES: readonly MemoryType[] = ["preference", "fact", "context", "equipment", "goal"];

/** Where a memory came from. chat: an explicit "Remember that" message. admin: typed in the admin app. */
export type MemorySourceType = "chat" | "note" | "document" | "admin";

export interface Memory {
  id: string;
  userId: string;
  memoryNumber: number;
  content: string;
  memoryType: MemoryType;
  importance: number | null;
  metadata: Record<string, string | number | boolean | null>;
  pinned: boolean;
  sourceType: MemorySourceType | null;
  sourceId: string | null;
  /** 0 to 1. An explicit user statement is 1. */
  confidence: number | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  deletedAt: string | null;
}

export interface AdminSession {
  id: string;
  userId: string;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface AuditEntry {
  id: string;
  userId: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  metadata: Record<string, string | number | boolean | null>;
  createdAt: string;
}

export interface UsageEntry {
  id: string;
  userId: string | null;
  model: string;
  purpose: string;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
  createdAt: string;
}
