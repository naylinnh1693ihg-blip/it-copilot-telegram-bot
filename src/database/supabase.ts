import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { IntentSchema, type Intent } from "../types/intent.js";
import type {
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
  User,
} from "../types/models.js";
import { DatabaseError } from "../utils/errors.js";
import { redactString } from "../utils/text.js";
import type { Database, NewDocument, NewKnowledge, NewNote, NewReminder, NewTask } from "./types.js";

type Row = Record<string, unknown>;

interface QueryError {
  message: string;
  code?: string;
}

function isRow(value: unknown): value is Row {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function rows(value: unknown): Row[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRow);
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new DatabaseError(`Column ${key} was not text.`);
  return value;
}

function textOrNull(row: Row, key: string): string | null {
  const value = row[key];
  if (value == null) return null;
  return text(row, key);
}

function integer(row: Row, key: string): number {
  const value = row[key];
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(number)) throw new DatabaseError(`Column ${key} was not a number.`);
  return number;
}

function textList(row: Row, key: string): string[] {
  const value = row[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function numberList(row: Row, key: string): number[] {
  const value = row[key];
  if (!Array.isArray(value)) return [];
  return value.map((item) => Number(item)).filter((item) => Number.isInteger(item));
}

function userFrom(row: Row, dailySummaryLocalTime: string | null): User {
  return {
    id: text(row, "id"),
    telegramUserId: integer(row, "telegram_user_id"),
    displayName: textOrNull(row, "display_name"),
    timezone: text(row, "timezone"),
    startedBot: row.started_bot === true,
    lastNotifiedReminderId: textOrNull(row, "last_notified_reminder_id"),
    dailySummaryLocalTime,
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
  };
}

function taskFrom(row: Row): Task {
  return {
    id: text(row, "id"),
    userId: text(row, "user_id"),
    taskNumber: integer(row, "task_number"),
    title: text(row, "title"),
    description: text(row, "description"),
    category: text(row, "category"),
    priority: text(row, "priority") as Priority,
    status: text(row, "status") as TaskStatus,
    dueAt: textOrNull(row, "due_at"),
    completedAt: textOrNull(row, "completed_at"),
    tags: textList(row, "tags"),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
    deletedAt: textOrNull(row, "deleted_at"),
  };
}

function reminderFrom(row: Row): Reminder {
  return {
    id: text(row, "id"),
    userId: text(row, "user_id"),
    reminderNumber: integer(row, "reminder_number"),
    title: text(row, "title"),
    message: text(row, "message"),
    kind: text(row, "kind") as ReminderKind,
    timezone: text(row, "timezone"),
    nextRunAt: text(row, "next_run_at"),
    weekdays: numberList(row, "weekdays"),
    intervalMinutes: row.interval_minutes == null ? null : integer(row, "interval_minutes"),
    status: text(row, "status") as ReminderStatus,
    dedupeKey: text(row, "dedupe_key"),
    attemptOccurrenceAt: textOrNull(row, "attempt_occurrence_at"),
    lockedUntil: textOrNull(row, "locked_until"),
    lockToken: textOrNull(row, "lock_token"),
    lastError: textOrNull(row, "last_error"),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
  };
}

function noteFrom(row: Row): Note {
  return {
    id: text(row, "id"),
    userId: text(row, "user_id"),
    noteNumber: integer(row, "note_number"),
    title: text(row, "title"),
    content: text(row, "content"),
    category: text(row, "category"),
    tags: textList(row, "tags"),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
    deletedAt: textOrNull(row, "deleted_at"),
  };
}

function knowledgeFrom(row: Row): KnowledgeEntry {
  return {
    id: text(row, "id"),
    userId: text(row, "user_id"),
    entryNumber: integer(row, "entry_number"),
    title: text(row, "title"),
    content: text(row, "content"),
    category: text(row, "category"),
    tags: textList(row, "tags"),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
    deletedAt: textOrNull(row, "deleted_at"),
  };
}

function documentFrom(row: Row): DocumentRecord {
  return {
    id: text(row, "id"),
    userId: text(row, "user_id"),
    documentNumber: integer(row, "document_number"),
    title: text(row, "title"),
    originalFilename: text(row, "original_filename"),
    storagePath: text(row, "storage_path"),
    mimeType: text(row, "mime_type"),
    byteSize: integer(row, "byte_size"),
    sha256: text(row, "sha256"),
    category: text(row, "category"),
    tags: textList(row, "tags"),
    createdAt: text(row, "created_at"),
    deletedAt: textOrNull(row, "deleted_at"),
  };
}

export function createSupabaseClient(url: string, serviceRoleKey: string): SupabaseClient {
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export class SupabaseDatabase implements Database {
  constructor(private readonly client: SupabaseClient) {}

  private raise(error: QueryError | null): void {
    if (!error) return;
    throw new DatabaseError(redactString(error.message));
  }

  private async preferenceTime(userId: string): Promise<string | null> {
    const { data, error } = await this.client.from("user_preferences").select("daily_summary_local_time").eq("user_id", userId).maybeSingle();
    this.raise(error);
    if (!isRow(data)) return null;
    return textOrNull(data, "daily_summary_local_time");
  }

  private async hydrate(row: Row): Promise<User> {
    return userFrom(row, await this.preferenceTime(text(row, "id")));
  }

  async ping(): Promise<{ ok: boolean; reason: string }> {
    const { error } = await this.client.from("users").select("id").limit(1);
    if (error) return { ok: false, reason: redactString(error.message) };
    return { ok: true, reason: "ok" };
  }

  async upsertFromTelegram(input: {
    telegramUserId: number;
    displayName: string | null;
    timezone: string;
    startedBot: boolean;
    at: string;
  }): Promise<User> {
    const existing = await this.client.from("users").select("*").eq("telegram_user_id", input.telegramUserId).maybeSingle();
    this.raise(existing.error);
    if (isRow(existing.data)) {
      const { data, error } = await this.client
        .from("users")
        .update({
          display_name: input.displayName,
          started_bot: existing.data.started_bot === true || input.startedBot,
        })
        .eq("id", existing.data.id)
        .select("*")
        .single();
      this.raise(error);
      return this.hydrate(isRow(data) ? data : existing.data);
    }
    const inserted = await this.client
      .from("users")
      .insert({
        telegram_user_id: input.telegramUserId,
        display_name: input.displayName,
        timezone: input.timezone,
        started_bot: input.startedBot,
      })
      .select("*")
      .single();
    this.raise(inserted.error);
    if (!isRow(inserted.data)) throw new DatabaseError("User insert returned no row.");
    return this.hydrate(inserted.data);
  }

  async findUserById(id: string): Promise<User | null> {
    const { data, error } = await this.client.from("users").select("*").eq("id", id).maybeSingle();
    this.raise(error);
    if (!isRow(data)) return null;
    return this.hydrate(data);
  }

  async setLastNotifiedReminder(userId: string, reminderId: string | null, _at: string): Promise<void> {
    const { error } = await this.client.from("users").update({ last_notified_reminder_id: reminderId }).eq("id", userId);
    this.raise(error);
  }

  async setDailySummaryTime(userId: string, time: string | null, _at: string): Promise<void> {
    const { error } = await this.client.from("user_preferences").update({ daily_summary_local_time: time }).eq("user_id", userId);
    this.raise(error);
  }

  private async allocate(userId: string, kind: string): Promise<number> {
    const { data, error } = await this.client.rpc("alloc_number", { p_user: userId, p_kind: kind });
    this.raise(error);
    const number = typeof data === "number" ? data : Number(data);
    if (!Number.isInteger(number)) throw new DatabaseError("Could not allocate a record number.");
    return number;
  }

  async insertTask(input: NewTask): Promise<Task> {
    const taskNumber = await this.allocate(input.userId, "task");
    const { data, error } = await this.client
      .from("tasks")
      .insert({
        user_id: input.userId,
        task_number: taskNumber,
        title: input.title,
        description: input.description,
        category: input.category,
        priority: input.priority,
        status: input.status,
        due_at: input.dueAt,
        tags: input.tags,
        created_at: input.createdAt,
      })
      .select("*")
      .single();
    this.raise(error);
    if (!isRow(data)) throw new DatabaseError("Task insert returned no row.");
    return taskFrom(data);
  }

  async updateTask(task: Task): Promise<Task> {
    const { data, error } = await this.client
      .from("tasks")
      .update({
        title: task.title,
        description: task.description,
        category: task.category,
        priority: task.priority,
        status: task.status,
        due_at: task.dueAt,
        completed_at: task.completedAt,
        tags: task.tags,
        deleted_at: task.deletedAt,
      })
      .eq("id", task.id)
      .eq("user_id", task.userId)
      .select("*")
      .single();
    this.raise(error);
    if (!isRow(data)) throw new DatabaseError("Task update returned no row.");
    return taskFrom(data);
  }

  async findTask(userId: string, taskNumber: number): Promise<Task | null> {
    const { data, error } = await this.client.from("tasks").select("*").eq("user_id", userId).eq("task_number", taskNumber).maybeSingle();
    this.raise(error);
    return isRow(data) ? taskFrom(data) : null;
  }

  async listTasks(userId: string): Promise<Task[]> {
    const { data, error } = await this.client.from("tasks").select("*").eq("user_id", userId).is("deleted_at", null).order("task_number");
    this.raise(error);
    return rows(data).map(taskFrom);
  }

  async searchTasks(userId: string, query: string): Promise<Task[]> {
    const { data, error } = await this.client.rpc("search_tasks", { p_user: userId, p_query: query });
    this.raise(error);
    return rows(data).map(taskFrom);
  }

  async addTaskEvent(event: Omit<TaskEvent, "id">): Promise<void> {
    const { error } = await this.client.from("task_events").insert({
      task_id: event.taskId,
      user_id: event.userId,
      action: event.action,
      summary: event.summary,
      created_at: event.createdAt,
    });
    this.raise(error);
  }

  async listTaskEvents(userId: string, taskNumber: number): Promise<TaskEvent[]> {
    const task = await this.findTask(userId, taskNumber);
    if (!task) return [];
    const { data, error } = await this.client.from("task_events").select("*").eq("task_id", task.id).order("created_at");
    this.raise(error);
    return rows(data).map((row) => ({
      id: text(row, "id"),
      taskId: text(row, "task_id"),
      userId: text(row, "user_id"),
      action: text(row, "action"),
      summary: text(row, "summary"),
      createdAt: text(row, "created_at"),
    }));
  }

  async insertReminder(input: NewReminder): Promise<{ reminder: Reminder; created: boolean }> {
    const reminderNumber = await this.allocate(input.userId, "reminder");
    const inserted = await this.client
      .from("reminders")
      .insert({
        user_id: input.userId,
        reminder_number: reminderNumber,
        title: input.title,
        message: input.message,
        kind: input.kind,
        timezone: input.timezone,
        next_run_at: input.nextRunAt,
        weekdays: input.weekdays,
        interval_minutes: input.intervalMinutes,
        status: input.status,
        dedupe_key: input.dedupeKey,
        created_at: input.createdAt,
      })
      .select("*")
      .single();
    if (inserted.error?.code === "23505") {
      const { data, error } = await this.client
        .from("reminders")
        .select("*")
        .eq("user_id", input.userId)
        .eq("dedupe_key", input.dedupeKey)
        .eq("status", "active")
        .maybeSingle();
      this.raise(error);
      if (!isRow(data)) throw new DatabaseError("A matching reminder exists but could not be loaded.");
      return { reminder: reminderFrom(data), created: false };
    }
    this.raise(inserted.error);
    if (!isRow(inserted.data)) throw new DatabaseError("Reminder insert returned no row.");
    return { reminder: reminderFrom(inserted.data), created: true };
  }

  async updateReminder(reminder: Reminder): Promise<Reminder> {
    const { data, error } = await this.client
      .from("reminders")
      .update({
        title: reminder.title,
        message: reminder.message,
        kind: reminder.kind,
        timezone: reminder.timezone,
        next_run_at: reminder.nextRunAt,
        weekdays: reminder.weekdays,
        interval_minutes: reminder.intervalMinutes,
        status: reminder.status,
        dedupe_key: reminder.dedupeKey,
        attempt_occurrence_at: reminder.attemptOccurrenceAt,
        locked_until: reminder.lockedUntil,
        lock_token: reminder.lockToken,
        last_error: reminder.lastError,
      })
      .eq("id", reminder.id)
      .eq("user_id", reminder.userId)
      .select("*")
      .single();
    this.raise(error);
    if (!isRow(data)) throw new DatabaseError("Reminder update returned no row.");
    return reminderFrom(data);
  }

  async findReminder(userId: string, reminderNumber: number): Promise<Reminder | null> {
    const { data, error } = await this.client.from("reminders").select("*").eq("user_id", userId).eq("reminder_number", reminderNumber).maybeSingle();
    this.raise(error);
    return isRow(data) ? reminderFrom(data) : null;
  }

  async listReminders(userId: string): Promise<Reminder[]> {
    const { data, error } = await this.client.from("reminders").select("*").eq("user_id", userId).order("reminder_number");
    this.raise(error);
    return rows(data).map(reminderFrom);
  }

  async claimDueReminders(worker: string, limit: number, lockSeconds: number, _nowIso: string): Promise<Reminder[]> {
    const { data, error } = await this.client.rpc("claim_due_reminders", {
      p_worker: worker,
      p_limit: limit,
      p_lock_seconds: lockSeconds,
    });
    this.raise(error);
    return rows(data).map(reminderFrom);
  }

  async startDelivery(reminderId: string, occurrenceAt: string, nowIso: string): Promise<{ action: "send" | "skip"; attempt: number }> {
    const existing = await this.client
      .from("reminder_delivery_logs")
      .select("*")
      .eq("reminder_id", reminderId)
      .eq("occurrence_at", occurrenceAt)
      .maybeSingle();
    this.raise(existing.error);
    if (!isRow(existing.data)) {
      const { error } = await this.client.from("reminder_delivery_logs").insert({
        reminder_id: reminderId,
        occurrence_at: occurrenceAt,
        status: "pending",
        attempt: 1,
        created_at: nowIso,
      });
      this.raise(error);
      return { action: "send", attempt: 1 };
    }
    if (existing.data.status === "sent") return { action: "skip", attempt: integer(existing.data, "attempt") };
    const attempt = integer(existing.data, "attempt") + 1;
    const { error } = await this.client
      .from("reminder_delivery_logs")
      .update({ status: "pending", attempt, updated_at: nowIso })
      .eq("id", existing.data.id);
    this.raise(error);
    return { action: "send", attempt };
  }

  async finishDelivery(
    reminderId: string,
    occurrenceAt: string,
    status: "sent" | "failed",
    errorText: string | null,
    messageId: number | null,
    nowIso: string,
  ): Promise<void> {
    const { error } = await this.client
      .from("reminder_delivery_logs")
      .update({
        status,
        error: errorText,
        telegram_message_id: messageId,
        updated_at: nowIso,
      })
      .eq("reminder_id", reminderId)
      .eq("occurrence_at", occurrenceAt);
    this.raise(error);
  }

  async insertNote(input: NewNote): Promise<Note> {
    const noteNumber = await this.allocate(input.userId, "note");
    const { data, error } = await this.client
      .from("notes")
      .insert({
        user_id: input.userId,
        note_number: noteNumber,
        title: input.title,
        content: input.content,
        category: input.category,
        tags: input.tags,
        created_at: input.createdAt,
      })
      .select("*")
      .single();
    this.raise(error);
    if (!isRow(data)) throw new DatabaseError("Note insert returned no row.");
    return noteFrom(data);
  }

  async updateNote(note: Note): Promise<Note> {
    const { data, error } = await this.client
      .from("notes")
      .update({
        title: note.title,
        content: note.content,
        category: note.category,
        tags: note.tags,
        deleted_at: note.deletedAt,
      })
      .eq("id", note.id)
      .eq("user_id", note.userId)
      .select("*")
      .single();
    this.raise(error);
    if (!isRow(data)) throw new DatabaseError("Note update returned no row.");
    return noteFrom(data);
  }

  async findNote(userId: string, noteNumber: number): Promise<Note | null> {
    const { data, error } = await this.client.from("notes").select("*").eq("user_id", userId).eq("note_number", noteNumber).maybeSingle();
    this.raise(error);
    return isRow(data) ? noteFrom(data) : null;
  }

  async listNotes(userId: string): Promise<Note[]> {
    const { data, error } = await this.client.from("notes").select("*").eq("user_id", userId).is("deleted_at", null).order("note_number");
    this.raise(error);
    return rows(data).map(noteFrom);
  }

  async searchNotes(userId: string, query: string): Promise<Note[]> {
    const { data, error } = await this.client.rpc("search_notes", { p_user: userId, p_query: query });
    this.raise(error);
    return rows(data).map(noteFrom);
  }

  async linkNoteTask(noteId: string, taskId: string): Promise<void> {
    const { error } = await this.client.from("note_tasks").upsert({ note_id: noteId, task_id: taskId });
    this.raise(error);
  }

  async linkNoteDocument(noteId: string, documentId: string): Promise<void> {
    const { error } = await this.client.from("note_documents").upsert({ note_id: noteId, document_id: documentId });
    this.raise(error);
  }

  async insertKnowledge(input: NewKnowledge): Promise<KnowledgeEntry> {
    const entryNumber = await this.allocate(input.userId, "knowledge");
    const { data, error } = await this.client
      .from("knowledge_entries")
      .insert({
        user_id: input.userId,
        entry_number: entryNumber,
        title: input.title,
        content: input.content,
        category: input.category,
        tags: input.tags,
        created_at: input.createdAt,
      })
      .select("*")
      .single();
    this.raise(error);
    if (!isRow(data)) throw new DatabaseError("Knowledge insert returned no row.");
    return knowledgeFrom(data);
  }

  async listKnowledge(userId: string): Promise<KnowledgeEntry[]> {
    const { data, error } = await this.client.from("knowledge_entries").select("*").eq("user_id", userId).is("deleted_at", null).order("entry_number");
    this.raise(error);
    return rows(data).map(knowledgeFrom);
  }

  async searchKnowledge(userId: string, query: string): Promise<KnowledgeEntry[]> {
    const { data, error } = await this.client.rpc("search_knowledge", { p_user: userId, p_query: query });
    this.raise(error);
    return rows(data).map(knowledgeFrom);
  }

  async insertDocument(input: NewDocument): Promise<DocumentRecord> {
    const documentNumber = await this.allocate(input.userId, "document");
    const { data, error } = await this.client
      .from("documents")
      .insert({
        id: input.id,
        user_id: input.userId,
        document_number: documentNumber,
        title: input.title,
        original_filename: input.originalFilename,
        storage_path: input.storagePath,
        mime_type: input.mimeType,
        byte_size: input.byteSize,
        sha256: input.sha256,
        category: input.category,
        tags: input.tags,
        created_at: input.createdAt,
      })
      .select("*")
      .single();
    this.raise(error);
    if (!isRow(data)) throw new DatabaseError("Document insert returned no row.");
    return documentFrom(data);
  }

  async findDocument(userId: string, documentNumber: number): Promise<DocumentRecord | null> {
    const { data, error } = await this.client
      .from("documents")
      .select("*")
      .eq("user_id", userId)
      .eq("document_number", documentNumber)
      .is("deleted_at", null)
      .maybeSingle();
    this.raise(error);
    return isRow(data) ? documentFrom(data) : null;
  }

  async renameDocument(userId: string, documentNumber: number, title: string): Promise<DocumentRecord | null> {
    const { data, error } = await this.client
      .from("documents")
      .update({ title })
      .eq("user_id", userId)
      .eq("document_number", documentNumber)
      .is("deleted_at", null)
      .select("*")
      .maybeSingle();
    this.raise(error);
    return isRow(data) ? documentFrom(data) : null;
  }

  async findDocumentByHash(userId: string, sha256: string): Promise<DocumentRecord | null> {
    const { data, error } = await this.client
      .from("documents")
      .select("*")
      .eq("user_id", userId)
      .eq("sha256", sha256)
      .is("deleted_at", null)
      .maybeSingle();
    this.raise(error);
    return isRow(data) ? documentFrom(data) : null;
  }

  async listDocuments(userId: string): Promise<DocumentRecord[]> {
    const { data, error } = await this.client.from("documents").select("*").eq("user_id", userId).is("deleted_at", null).order("document_number");
    this.raise(error);
    return rows(data).map(documentFrom);
  }

  async searchDocuments(userId: string, query: string): Promise<DocumentRecord[]> {
    const { data, error } = await this.client.rpc("search_documents", { p_user: userId, p_query: query });
    this.raise(error);
    return rows(data).map(documentFrom);
  }

  async saveExtraction(extraction: Extraction): Promise<void> {
    const { error } = await this.client.from("document_extractions").upsert({
      document_id: extraction.documentId,
      content: extraction.text,
      truncated: extraction.truncated,
      extracted_at: extraction.extractedAt,
    });
    this.raise(error);
  }

  async getExtraction(documentId: string): Promise<Extraction | null> {
    const { data, error } = await this.client.from("document_extractions").select("*").eq("document_id", documentId).maybeSingle();
    this.raise(error);
    if (!isRow(data)) return null;
    return {
      documentId: text(data, "document_id"),
      text: text(data, "content"),
      truncated: data.truncated === true,
      extractedAt: text(data, "extracted_at"),
    };
  }

  async claimUpdate(updateId: number, telegramUserId: number | null, at: string): Promise<boolean> {
    const { error } = await this.client.from("telegram_updates").insert({
      update_id: updateId,
      telegram_user_id: telegramUserId,
      processed_at: at,
    });
    if (error?.code === "23505") return false;
    this.raise(error);
    return true;
  }

  async putConfirmation(userId: string, action: Intent, expiresAt: string): Promise<void> {
    const { error } = await this.client.from("pending_confirmations").upsert({
      user_id: userId,
      action,
      expires_at: expiresAt,
    });
    this.raise(error);
  }

  async getConfirmation(userId: string): Promise<{ action: Intent; expiresAt: string } | null> {
    const { data, error } = await this.client.from("pending_confirmations").select("*").eq("user_id", userId).maybeSingle();
    this.raise(error);
    if (!isRow(data)) return null;
    const parsed = IntentSchema.safeParse(data.action);
    if (!parsed.success) {
      await this.clearConfirmation(userId);
      return null;
    }
    return { action: parsed.data, expiresAt: text(data, "expires_at") };
  }

  async clearConfirmation(userId: string): Promise<void> {
    const { error } = await this.client.from("pending_confirmations").delete().eq("user_id", userId);
    this.raise(error);
  }

  async appendTurn(userId: string, role: "user" | "assistant", content: string, at: string): Promise<void> {
    const { error } = await this.client.from("conversation_turns").insert({
      user_id: userId,
      role,
      content: content.slice(0, 2000),
      created_at: at,
    });
    this.raise(error);
    const listed = await this.client.from("conversation_turns").select("id").eq("user_id", userId).order("created_at", { ascending: false });
    this.raise(listed.error);
    const extra = rows(listed.data).slice(30);
    if (extra.length === 0) return;
    const { error: deleteError } = await this.client.from("conversation_turns").delete().in("id", extra.map((row) => text(row, "id")));
    this.raise(deleteError);
  }

  async recentTurns(userId: string, limit: number): Promise<ConversationTurn[]> {
    const { data, error } = await this.client
      .from("conversation_turns")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(limit);
    this.raise(error);
    return rows(data)
      .reverse()
      .map((row) => ({
        id: text(row, "id"),
        userId: text(row, "user_id"),
        role: text(row, "role") === "assistant" ? "assistant" : "user",
        content: text(row, "content"),
        createdAt: text(row, "created_at"),
      }));
  }

  async writeAudit(entry: Omit<import("../types/models.js").AuditEntry, "id">): Promise<void> {
    const { error } = await this.client.from("audit_logs").insert({
      user_id: entry.userId,
      action: entry.action,
      entity: entry.entity,
      entity_id: entry.entityId,
      metadata: entry.metadata,
      created_at: entry.createdAt,
    });
    this.raise(error);
  }

  async recordUsage(entry: Omit<import("../types/models.js").UsageEntry, "id">): Promise<void> {
    const { error } = await this.client.from("ai_usage").insert({
      user_id: entry.userId,
      model: entry.model,
      purpose: entry.purpose,
      input_tokens: entry.inputTokens,
      output_tokens: entry.outputTokens,
      estimated_usd: entry.estimatedUsd,
      created_at: entry.createdAt,
    });
    this.raise(error);
  }
}
