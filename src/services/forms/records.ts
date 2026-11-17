import type { Deps } from "../../app/deps.js";
import type { Database } from "../../database/types.js";
import { dateValue, tagsValue, textValue, type FormData } from "../../forms/definition.js";
import type { User } from "../../types/models.js";
import { EQUIPMENT_KINDS, EQUIPMENT_STATUSES, LINK_CATEGORIES, type EquipmentKind, type EquipmentStatus, type LinkCategory } from "../../types/models.js";
import { redactString } from "../../utils/text.js";
import { toIso } from "../../utils/time.js";

export interface SavedFormRecord {
  number: number;
  /** The part after the number, such as "Dell Latitude 5440, Floor 2". */
  summary: string;
}

export interface FormRecordRow {
  number: number;
  title: string;
  detail: string;
  createdAt: string;
}

function oneOf<T extends string>(values: readonly T[], value: string, label: string): T {
  const found = values.find((item) => item === value);
  if (!found) throw new Error(`${label} was not one of the allowed values.`);
  return found;
}

function matches(query: string, parts: string[]): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return parts.join("\n").toLowerCase().includes(needle);
}

export async function saveFormRecord(deps: Deps, user: User, formId: string, data: FormData): Promise<SavedFormRecord> {
  const at = toIso(deps.clock.now());
  if (formId === "equipment") return saveEquipment(deps.db, user.id, data, at);
  if (formId === "contact") return saveContact(deps.db, user.id, data, at);
  if (formId === "link") return saveLink(deps.db, user.id, data, at);
  throw new Error(`Unknown form ${formId}.`);
}

async function saveEquipment(db: Database, userId: string, data: FormData, at: string): Promise<SavedFormRecord> {
  const name = textValue(data, "name");
  const location = textValue(data, "location");
  const kind = oneOf<EquipmentKind>(EQUIPMENT_KINDS, textValue(data, "kind"), "Type");
  const status = oneOf<EquipmentStatus>(EQUIPMENT_STATUSES, textValue(data, "status"), "Status");
  const saved = await db.insertEquipment({
    userId,
    name,
    kind,
    location,
    ipAddress: textValue(data, "ip_address"),
    serialNumber: textValue(data, "serial_number"),
    status,
    purchaseDate: dateValue(data, "purchase_date"),
    warrantyEnd: dateValue(data, "warranty_end"),
    notes: textValue(data, "notes"),
    sourceNoteId: null,
    sourceDocumentId: null,
    createdAt: at,
  });
  return { number: saved.equipmentNumber, summary: location ? `${name}, ${location}` : name };
}

async function saveContact(db: Database, userId: string, data: FormData, at: string): Promise<SavedFormRecord> {
  const fullName = textValue(data, "full_name");
  const saved = await db.insertContact({
    userId,
    fullName,
    email: textValue(data, "email"),
    phone: textValue(data, "phone"),
    department: textValue(data, "department"),
    jobTitle: textValue(data, "job_title"),
    location: textValue(data, "location"),
    telegramUsername: textValue(data, "telegram_username").replace(/^@/, ""),
    notes: textValue(data, "notes"),
    createdAt: at,
  });
  return { number: saved.contactNumber, summary: fullName };
}

async function saveLink(db: Database, userId: string, data: FormData, at: string): Promise<SavedFormRecord> {
  const title = textValue(data, "title");
  const category = oneOf<LinkCategory>(LINK_CATEGORIES, textValue(data, "category"), "Category");
  const saved = await db.insertSavedLink({
    userId,
    url: textValue(data, "url"),
    title,
    category,
    tags: tagsValue(data, "tags"),
    description: textValue(data, "description"),
    createdAt: at,
  });
  return { number: saved.linkNumber, summary: title };
}

export async function listFormRecords(deps: Deps, userId: string, formId: string, query: string): Promise<FormRecordRow[]> {
  const needle = query.replace(/[%_]/g, "").slice(0, 200);
  if (formId === "equipment") {
    const rows = (await deps.db.listEquipment(userId)).sort(newest);
    return rows
      .filter((item) => matches(needle, [item.name, item.location, item.ipAddress, item.serialNumber, item.kind, item.status, item.notes]))
      .slice(0, 50)
      .map((item) => ({
        number: item.equipmentNumber,
        title: item.name,
        detail: item.location || item.serialNumber || item.status.replaceAll("_", " "),
        createdAt: item.createdAt,
      }));
  }
  if (formId === "contact") {
    const rows = await deps.db.listContacts(userId);
    return rows
      .filter((item) => matches(needle, [item.fullName, item.email, item.phone, item.department, item.jobTitle, item.location, item.telegramUsername, item.notes]))
      .slice(0, 50)
      .map((item) => ({
        number: item.contactNumber,
        title: item.fullName,
        detail: item.email || item.department || item.phone,
        createdAt: item.createdAt,
      }));
  }
  if (formId === "link") {
    const rows = await deps.db.listSavedLinks(userId);
    return rows
      .filter((item) => matches(needle, [item.title, item.url, item.category, item.description, item.tags.join(" ")]))
      .slice(0, 50)
      .map((item) => ({
        number: item.linkNumber,
        title: item.title,
        detail: item.url,
        createdAt: item.createdAt,
      }));
  }
  return [];
}

function newest(left: { createdAt: string; equipmentNumber: number }, right: { createdAt: string; equipmentNumber: number }): number {
  return right.createdAt.localeCompare(left.createdAt) || right.equipmentNumber - left.equipmentNumber;
}

export function confirmationText(formId: string, saved: SavedFormRecord): string {
  const noun = formId === "equipment" ? "equipment" : formId === "contact" ? "contact" : "link";
  return `Saved ${noun} #${saved.number}: ${saved.summary}.`;
}

export function logFormFailure(deps: Deps, error: unknown): void {
  deps.logger.warn(
    { event: "form_side_effect_failed", message: redactString(error instanceof Error ? error.message : "error") },
    "form save side effect failed",
  );
}
