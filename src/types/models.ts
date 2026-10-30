export type TaskStatus = "pending" | "in_progress" | "completed" | "cancelled";
export type Priority = "low" | "normal" | "high" | "urgent";
export type ReminderKind = "once" | "daily" | "weekly" | "interval" | "daily_summary";
export type ReminderStatus = "active" | "completed" | "cancelled" | "failed";

export interface User {
  id: string;
  telegramUserId: number;
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
