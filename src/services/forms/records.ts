import type { Deps } from "../../app/deps.js";
import type { Database } from "../../database/types.js";
import { cidrContains, ipv4ToInt } from "../../forms/checks.js";
import { birthdayValue, dateValue, idValue, tagsValue, textValue, type FormData } from "../../forms/definition.js";
import type { Book, Contact, Equipment, IpAddress, Location, User } from "../../types/models.js";
import { BOOK_CATEGORIES, BOOK_FORMATS, BOOK_STATUSES, EQUIPMENT_KINDS, EQUIPMENT_STATUSES, IP_KINDS, LINK_CATEGORIES, LOCATION_KINDS, type BookCategory, type BookFormat, type BookStatus, type EquipmentKind, type EquipmentStatus, type IpKind, type LinkCategory, type LocationKind } from "../../types/models.js";
import { redactString } from "../../utils/text.js";
import { toIso } from "../../utils/time.js";
import { syncBirthdayReminder } from "./birthdays.js";

export interface SavedFormRecord {
  number: number;
  /** The part after the number, such as "Dell Latitude 5440, Floor 2". */
  summary: string;
}

export interface FormRecordRow {
  id?: string;
  number: number;
  title: string;
  detail: string;
  createdAt: string;
  columns?: string[];
  depth?: number;
  legacy?: string;
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
  if (formId === "contact") return saveContact(deps, user.id, data, at);
  if (formId === "link") return saveLink(deps.db, user.id, data, at);
  if (formId === "location") return saveLocation(deps.db, user.id, data, at);
  if (formId === "book") return saveBook(deps.db, user.id, data, at);
  if (formId === "ip") return saveIp(deps.db, user.id, data, at);
  throw new Error(`Unknown form ${formId}.`);
}

async function saveEquipment(db: Database, userId: string, data: FormData, at: string): Promise<SavedFormRecord> {
  const name = textValue(data, "name");
  const kind = oneOf<EquipmentKind>(EQUIPMENT_KINDS, textValue(data, "kind"), "Type");
  const status = oneOf<EquipmentStatus>(EQUIPMENT_STATUSES, textValue(data, "status"), "Status");
  const locationId = idValue(data, "location_id");
  const saved = await db.saveEquipmentAndIp({
    userId,
    name,
    kind,
    location: "",
    ipAddress: textValue(data, "ip_address"),
    serialNumber: textValue(data, "serial_number"),
    status,
    purchaseDate: dateValue(data, "purchase_date"),
    warrantyEnd: dateValue(data, "warranty_end"),
    locationId,
    notes: textValue(data, "notes"),
    sourceNoteId: null,
    sourceDocumentId: null,
    createdAt: at,
  });
  const place = locationId ? (await db.listLocations(userId)).find((item) => item.id === locationId) : undefined;
  return { number: saved.equipmentNumber, summary: place ? `${name}, ${place.name}` : name };
}

async function saveContact(deps: Deps, userId: string, data: FormData, at: string): Promise<SavedFormRecord> {
  const fullName = textValue(data, "full_name");
  const birthday = birthdayValue(data, "birthday");
  const reminderText = textValue(data, "birthday_reminder");
  const birthdayReminder = reminderText === "on_the_day" || reminderText === "none" || reminderText === "day_before" ? reminderText : "day_before";
  const saved = await deps.db.insertContact({
    userId,
    fullName,
    email: textValue(data, "email"),
    phone: textValue(data, "phone"),
    department: textValue(data, "department"),
    jobTitle: textValue(data, "job_title"),
    location: "",
    telegramUsername: textValue(data, "telegram_username").replace(/^@/, ""),
    notes: textValue(data, "notes"),
    locationId: idValue(data, "location_id"),
    birthDay: birthday.day,
    birthMonth: birthday.month,
    birthYear: birthday.year,
    birthdayReminder,
    createdAt: at,
  });
  await syncBirthdayReminder(deps, saved);
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

async function saveLocation(db: Database, userId: string, data: FormData, at: string): Promise<SavedFormRecord> {
  const name = textValue(data, "name");
  const saved = await db.insertLocation({
    userId,
    name,
    kind: oneOf<LocationKind>(LOCATION_KINDS, textValue(data, "kind"), "Kind"),
    parentLocationId: idValue(data, "parent_location_id"),
    streetAddress: textValue(data, "street_address"),
    city: textValue(data, "city"),
    country: textValue(data, "country"),
    postalCode: textValue(data, "postal_code"),
    mapUrl: textValue(data, "map_url"),
    siteContactId: idValue(data, "site_contact_id"),
    notes: textValue(data, "notes"),
    createdAt: at,
  });
  return { number: saved.locationNumber, summary: name };
}

async function saveBook(db: Database, userId: string, data: FormData, at: string): Promise<SavedFormRecord> {
  const title = textValue(data, "title");
  const yearText = textValue(data, "year");
  const saved = await db.insertBook({
    userId,
    title,
    author: textValue(data, "author"),
    isbn: textValue(data, "isbn"),
    publisher: textValue(data, "publisher"),
    year: yearText ? Number(yearText) : null,
    category: oneOf<BookCategory>(BOOK_CATEGORIES, textValue(data, "category"), "Category"),
    format: oneOf<BookFormat>(BOOK_FORMATS, textValue(data, "format"), "Format"),
    status: oneOf<BookStatus>(BOOK_STATUSES, textValue(data, "status"), "Status"),
    lentToContactId: idValue(data, "lent_to_contact_id"),
    lentOn: dateValue(data, "lent_on"),
    notes: textValue(data, "notes"),
    createdAt: at,
  });
  return { number: saved.bookNumber, summary: title };
}

async function saveIp(db: Database, userId: string, data: FormData, at: string): Promise<SavedFormRecord> {
  const ip = textValue(data, "ip");
  const vlan = textValue(data, "vlan");
  const saved = await db.saveIpAndEquipment({
    userId,
    ip,
    subnet: textValue(data, "subnet") || null,
    vlan: vlan ? Number(vlan) : null,
    hostname: textValue(data, "hostname"),
    macAddress: textValue(data, "mac_address"),
    kind: oneOf<IpKind>(IP_KINDS, textValue(data, "kind"), "Type"),
    equipmentId: idValue(data, "equipment_id"),
    locationId: idValue(data, "location_id"),
    notes: textValue(data, "notes"),
    createdAt: at,
  });
  return { number: saved.ipNumber, summary: saved.ip };
}

export async function listFormRecords(deps: Deps, userId: string, formId: string, query: string, subnet = ""): Promise<FormRecordRow[]> {
  const needle = query.replace(/[%_]/g, "").slice(0, 200);
  if (formId === "equipment") {
    const rows = (await deps.db.listEquipment(userId)).sort(newest);
    return rows
      .filter((item) => matches(needle, [item.name, item.location, item.ipAddress, item.serialNumber, item.kind, item.status, item.notes]))
      .slice(0, 50)
      .map((item) => ({
        id: item.id,
        number: item.equipmentNumber,
        title: item.name,
        detail: item.locationId ? item.serialNumber || item.status.replaceAll("_", " ") : item.location || item.serialNumber || item.status.replaceAll("_", " "),
        createdAt: item.createdAt,
        legacy: item.location && !item.locationId ? `Old location text: ${item.location}` : undefined,
      }));
  }
  if (formId === "contact") {
    const rows = await deps.db.listContacts(userId);
    return rows
      .filter((item) => matches(needle, [item.fullName, item.email, item.phone, item.department, item.jobTitle, item.location, item.telegramUsername, item.notes]))
      .slice(0, 50)
      .map((item) => ({
        id: item.id,
        number: item.contactNumber,
        title: item.fullName,
        detail: item.email || item.department || item.phone,
        createdAt: item.createdAt,
        legacy: item.location && !item.locationId ? `Old location text: ${item.location}` : undefined,
      }));
  }
  if (formId === "link") {
    const rows = await deps.db.listSavedLinks(userId);
    return rows
      .filter((item) => matches(needle, [item.title, item.url, item.category, item.description, item.tags.join(" ")]))
      .slice(0, 50)
      .map((item) => ({
        id: item.id,
        number: item.linkNumber,
        title: item.title,
        detail: item.url,
        createdAt: item.createdAt,
      }));
  }
  if (formId === "location") return locationRows(await deps.db.listLocations(userId), await deps.db.listEquipment(userId), await deps.db.listContacts(userId), needle);
  if (formId === "book") return bookRows(await deps.db.listBooks(userId), await deps.db.listContacts(userId), needle);
  if (formId === "ip") return ipRows(await deps.db.listIpAddresses(userId), await deps.db.listEquipment(userId), await deps.db.listLocations(userId), needle, subnet);
  return [];
}

function locationRows(locations: Location[], equipment: Equipment[], contacts: Contact[], query: string): FormRecordRow[] {
  const byParent = new Map<string, Location[]>();
  for (const location of locations) {
    const key = location.parentLocationId ?? "";
    byParent.set(key, [...(byParent.get(key) ?? []), location]);
  }
  for (const list of byParent.values()) list.sort((left, right) => left.name.localeCompare(right.name));
  const rows: FormRecordRow[] = [];
  const walk = (parentId: string, depth: number): void => {
    for (const location of byParent.get(parentId) ?? []) {
      const devices = equipment.filter((item) => item.locationId === location.id).length;
      const people = contacts.filter((item) => item.locationId === location.id).length;
      const columns = [location.name, location.kind.replaceAll("_", " "), `${devices} equipment`, `${people} users`];
      if (matches(query, columns)) {
        rows.push({
          id: location.id,
          number: location.locationNumber,
          title: location.name,
          detail: `${devices} equipment, ${people} users`,
          createdAt: location.createdAt,
          columns,
          depth,
        });
      }
      walk(location.id, depth + 1);
    }
  };
  walk("", 0);
  return rows.slice(0, 50);
}

function bookRows(books: Book[], contacts: Contact[], query: string): FormRecordRow[] {
  return books
    .map((book) => {
      const lent = book.lentToContactId ? contacts.find((contact) => contact.id === book.lentToContactId)?.fullName ?? "" : "";
      const columns = [book.title, book.author, book.status.replaceAll("_", " "), lent];
      return { book, columns, lent };
    })
    .filter((row) => matches(query, [...row.columns, row.book.isbn, row.book.notes]))
    .slice(0, 50)
    .map((row) => ({
      id: row.book.id,
      number: row.book.bookNumber,
      title: row.book.title,
      detail: row.lent ? `Lent to ${row.lent}` : row.book.author,
      createdAt: row.book.createdAt,
      columns: row.columns,
    }));
}

function ipRows(addresses: IpAddress[], equipment: Equipment[], locations: Location[], query: string, subnet: string): FormRecordRow[] {
  const filter = subnet.trim();
  return addresses
    .filter((item) => !filter || cidrContains(item.ip, filter))
    .sort((left, right) => (ipv4ToInt(left.ip) ?? 0) - (ipv4ToInt(right.ip) ?? 0))
    .map((item) => {
      const device = item.equipmentId ? equipment.find((entry) => entry.id === item.equipmentId) : undefined;
      const place = item.locationId ? locations.find((entry) => entry.id === item.locationId) : undefined;
      const columns = [item.ip, item.hostname, device?.name ?? "", item.vlan == null ? "" : String(item.vlan), place?.name ?? "", item.kind.replaceAll("_", " ")];
      return { item, columns };
    })
    .filter((row) => matches(query, [...row.columns, row.item.notes, row.item.macAddress]))
    .slice(0, 50)
    .map((row) => ({
      id: row.item.id,
      number: row.item.ipNumber,
      title: row.item.ip,
      detail: row.columns[2] || row.item.hostname,
      createdAt: row.item.createdAt,
      columns: row.columns,
    }));
}

function newest(left: { createdAt: string; equipmentNumber: number }, right: { createdAt: string; equipmentNumber: number }): number {
  return right.createdAt.localeCompare(left.createdAt) || right.equipmentNumber - left.equipmentNumber;
}

export function confirmationText(formId: string, saved: SavedFormRecord): string {
  const noun = formId === "equipment" ? "equipment" : formId === "contact" ? "user" : formId === "location" ? "location" : formId === "book" ? "book" : formId === "ip" ? "IP address" : "link";
  return `Saved ${noun} #${saved.number}: ${saved.summary}.`;
}

export function logFormFailure(deps: Deps, error: unknown): void {
  deps.logger.warn(
    { event: "form_side_effect_failed", message: redactString(error instanceof Error ? error.message : "error") },
    "form save side effect failed",
  );
}
