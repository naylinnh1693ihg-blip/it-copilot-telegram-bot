export type TaskStatus = "pending" | "in_progress" | "completed" | "cancelled";
export type Priority = "low" | "normal" | "high" | "urgent";
export type ReminderKind = "once" | "daily" | "weekly" | "interval" | "daily_summary" | "yearly";
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
  /** Team group the reminder was created in. Null: the owner's private chat. */
  deliveryChatId: number | null;
  /** Forum topic in that group, so the reminder lands where it was asked for. */
  deliveryThreadId: number | null;
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

export const EQUIPMENT_KINDS = ["printer", "switch", "access_point", "laptop", "monitor", "server", "other"] as const;
export type EquipmentKind = (typeof EQUIPMENT_KINDS)[number];

export const EQUIPMENT_STATUSES = ["in_use", "in_stock", "in_repair", "retired"] as const;
export type EquipmentStatus = (typeof EQUIPMENT_STATUSES)[number];

export const LINK_CATEGORIES = ["documentation", "vendor_portal", "tool", "troubleshooting", "other"] as const;
export type LinkCategory = (typeof LINK_CATEGORIES)[number];

export const LOCATION_KINDS = ["site", "building", "floor", "room", "data_center", "remote"] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];

export const BOOK_CATEGORIES = ["networking", "security", "cloud", "programming", "management", "other"] as const;
export type BookCategory = (typeof BOOK_CATEGORIES)[number];
export const BOOK_FORMATS = ["physical", "ebook", "pdf", "audiobook"] as const;
export type BookFormat = (typeof BOOK_FORMATS)[number];
export const BOOK_STATUSES = ["to_read", "reading", "finished", "lent_out"] as const;
export type BookStatus = (typeof BOOK_STATUSES)[number];

export const IP_KINDS = ["static", "dhcp_reservation", "gateway", "dns", "reserved"] as const;
export type IpKind = (typeof IP_KINDS)[number];

export const BIRTHDAY_REMINDERS = ["day_before", "on_the_day", "none"] as const;
export type BirthdayReminder = (typeof BIRTHDAY_REMINDERS)[number];

export interface Equipment {
  id: string;
  userId: string;
  equipmentNumber: number;
  name: string;
  kind: EquipmentKind;
  location: string;
  ipAddress: string;
  serialNumber: string;
  status: EquipmentStatus;
  purchaseDate: string | null;
  warrantyEnd: string | null;
  locationId: string | null;
  notes: string;
  sourceNoteId: string | null;
  sourceDocumentId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface Contact {
  id: string;
  userId: string;
  contactNumber: number;
  fullName: string;
  email: string;
  phone: string;
  department: string;
  jobTitle: string;
  location: string;
  telegramUsername: string;
  notes: string;
  locationId: string | null;
  birthDay: number | null;
  birthMonth: number | null;
  birthYear: number | null;
  birthdayReminder: BirthdayReminder;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface Location {
  id: string;
  userId: string;
  locationNumber: number;
  name: string;
  kind: LocationKind;
  parentLocationId: string | null;
  streetAddress: string;
  city: string;
  country: string;
  postalCode: string;
  mapUrl: string;
  siteContactId: string | null;
  notes: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface Book {
  id: string;
  userId: string;
  bookNumber: number;
  title: string;
  author: string;
  isbn: string;
  publisher: string;
  year: number | null;
  category: BookCategory;
  format: BookFormat;
  status: BookStatus;
  lentToContactId: string | null;
  lentOn: string | null;
  notes: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface IpAddress {
  id: string;
  userId: string;
  ipNumber: number;
  ip: string;
  subnet: string | null;
  vlan: number | null;
  hostname: string;
  macAddress: string;
  kind: IpKind;
  equipmentId: string | null;
  locationId: string | null;
  notes: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface SavedLink {
  id: string;
  userId: string;
  linkNumber: number;
  url: string;
  title: string;
  category: LinkCategory;
  tags: string[];
  description: string;
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
