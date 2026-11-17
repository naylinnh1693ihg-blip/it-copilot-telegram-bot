import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { MemoryDatabase } from "../src/database/memory.js";
import { bookSchema } from "../src/forms/book.js";
import { calendarBirthday, syncBirthdayReminder } from "../src/services/forms/birthdays.js";
import { ipSchema } from "../src/forms/ipAddress.js";
import { locationSchema } from "../src/forms/location.js";
import { contactSchema } from "../src/forms/contact.js";
import { saveFormRecord } from "../src/services/forms/records.js";
import { handleText } from "../src/services/assistant/handleText.js";
import { listBirthdayEntries } from "../src/services/forms/birthdays.js";
import { NOW, ZONE, owner, testDeps } from "./helpers.js";

function issues(result: { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } }): Record<string, string> {
  const errors: Record<string, string> = {};
  if (result.success || !result.error) return errors;
  for (const issue of result.error.issues) {
    const key = String(issue.path[0] ?? "form");
    if (!errors[key]) errors[key] = issue.message;
  }
  return errors;
}

const location = {
  name: "Floor 2",
  kind: "floor",
  city: "Dubai",
  country: "AE",
};

describe("new form validators", () => {
  it("accepts a location, a book, and an IP address", () => {
    expect(locationSchema.safeParse(location).success).toBe(true);
    const book = bookSchema.safeParse({
      title: "Computer Networks",
      author: "Andrew Tanenbaum",
      isbn: "978-0-306-40615-7",
      category: "networking",
      format: "physical",
      status: "to_read",
    });
    expect(book.success).toBe(true);
    if (book.success) expect(book.data.isbn).toBe("9780306406157");
    const ip = ipSchema.safeParse({ ip: "192.168.1.10", subnet: "192.168.1.0/24", mac_address: "aa-bb-cc-dd-ee-ff", vlan: "10" });
    expect(ip.success).toBe(true);
    if (ip.success) expect(ip.data.mac_address).toBe("AA:BB:CC:DD:EE:FF");
  });

  it("rejects a bad ISBN, CIDR, MAC, VLAN, country, birthday, and a loan with nobody", () => {
    expect(issues(bookSchema.safeParse({ title: "Computer Networks", author: "Andrew Tanenbaum", isbn: "9780306406158", category: "networking", format: "physical", status: "to_read" })).isbn).toMatch(/checksum/);
    expect(issues(bookSchema.safeParse({ title: "Computer Networks", author: "Andrew Tanenbaum", year: "1449", category: "networking", format: "physical", status: "to_read" })).year).toMatch(/1450/);
    expect(issues(bookSchema.safeParse({ title: "Computer Networks", author: "Andrew Tanenbaum", category: "networking", format: "physical", status: "lent_out" })).lent_to_contact_id).toMatch(/who has this book/);
    expect(issues(ipSchema.safeParse({ ip: "10.0.0.8", subnet: "192.168.1.0/24" })).ip).toMatch(/not inside/);
    expect(issues(ipSchema.safeParse({ ip: "192.168.1.10", mac_address: "not-a-mac" })).mac_address).toMatch(/MAC/);
    expect(issues(ipSchema.safeParse({ ip: "192.168.1.10", vlan: "4095" })).vlan).toMatch(/4094/);
    expect(issues(locationSchema.safeParse({ ...location, country: "ZZ" })).country).toMatch(/country/);
    expect(issues(contactSchema.safeParse({ full_name: "Aung Min", birthday: { day: "31", month: "4", year: "" } })).birthday).toMatch(/does not exist/);
    expect(issues(contactSchema.safeParse({ full_name: "Aung Min", birthday: { day: "29", month: "2", year: "2023" } })).birthday).toMatch(/leap year/);
    expect(contactSchema.safeParse({ full_name: "Aung Min", birthday: { day: "29", month: "2", year: "" } }).success).toBe(true);
  });
});

describe("locations, refs, and IP sync", () => {
  it("rejects another user's contact and a parent loop", async () => {
    const { deps, db } = testDeps();
    const nay = await owner(db);
    const other = await db.upsertFromTelegram({ telegramUserId: 99, displayName: "Other", timezone: ZONE, startedBot: true, at: NOW });
    const theirs = await db.insertContact({
      userId: other.id,
      fullName: "Other Person",
      email: "",
      phone: "",
      department: "",
      jobTitle: "",
      location: "",
      telegramUsername: "",
      notes: "",
      createdAt: NOW,
    });
    await expect(db.insertLocation({
      userId: nay.id,
      name: "HQ",
      kind: "site",
      parentLocationId: null,
      streetAddress: "",
      city: "Dubai",
      country: "AE",
      postalCode: "",
      mapUrl: "",
      siteContactId: theirs.id,
      notes: "",
      createdAt: NOW,
    })).rejects.toThrow(/own list/);

    const parent = await db.insertLocation({
      userId: nay.id,
      name: "HQ",
      kind: "site",
      parentLocationId: null,
      streetAddress: "",
      city: "Dubai",
      country: "AE",
      postalCode: "",
      mapUrl: "",
      siteContactId: null,
      notes: "",
      createdAt: NOW,
    });
    const child = await db.insertLocation({
      userId: nay.id,
      name: "Floor 2",
      kind: "floor",
      parentLocationId: parent.id,
      streetAddress: "",
      city: "Dubai",
      country: "AE",
      postalCode: "",
      mapUrl: "",
      siteContactId: null,
      notes: "",
      createdAt: NOW,
    });
    await expect((db as MemoryDatabase).moveLocation(nay.id, parent.id, child.id)).rejects.toThrow(/inside itself/);

    const second = await saveFormRecord(deps, nay, "location", {
      name: "Warehouse",
      kind: "building",
      city: "Dubai",
      country: "AE",
      parent_location_id: parent.id,
    });
    expect(second.summary).toBe("Warehouse");
    const saved = (await db.listLocations(nay.id)).find((item) => item.name === "Warehouse");
    expect(saved?.parentLocationId).toBe(parent.id);
  });

  it("creates, links, and rejects a conflicting IP, and rolls back a failed write", async () => {
    const { deps, db } = testDeps();
    const nay = await owner(db);
    const memory = db as MemoryDatabase;
    await saveFormRecord(deps, nay, "equipment", {
      name: "HP LaserJet",
      kind: "printer",
      status: "in_use",
      ip_address: "192.168.1.10",
    });
    const linked = await db.listIpAddresses(nay.id);
    expect(linked).toHaveLength(1);
    expect(linked[0]?.equipmentId).toBe((await db.listEquipment(nay.id))[0]?.id);

    await expect(saveFormRecord(deps, nay, "equipment", {
      name: "Other printer",
      kind: "printer",
      status: "in_use",
      ip_address: "192.168.1.10",
    })).rejects.toThrow("192.168.1.10 is already assigned to HP LaserJet (#1).");
    expect(await db.listEquipment(nay.id)).toHaveLength(1);

    memory.failNextIpWrite = true;
    await expect(db.saveEquipmentAndIp({
      userId: nay.id,
      name: "Switch",
      kind: "switch",
      location: "Floor 2",
      ipAddress: "192.168.1.20",
      notes: "",
      sourceNoteId: null,
      sourceDocumentId: null,
      createdAt: NOW,
    })).rejects.toThrow(/ip write failed/);
    expect(await db.listEquipment(nay.id)).toHaveLength(1);
    expect(await db.listIpAddresses(nay.id)).toHaveLength(1);

    const chat = await handleText(deps, nay, "What's the IP of the main switch?");
    expect(chat.text).toContain("I don't have equipment matching");
    const saved = await handleText(deps, nay, "Add equipment: Core switch, Floor 2, 192.168.1.30");
    expect(saved.text).toContain("192.168.1.30");
    const lookedUp = await handleText(deps, nay, "What's the IP of the Core switch?");
    expect(lookedUp.text).toContain("192.168.1.30");
  });
});

describe("birthdays", () => {
  it("orders the next dates, including 29 February, and keeps one reminder", async () => {
    const { deps, db } = testDeps();
    const nay = await owner(db);
    const people = [
      ["November", 11, 2, 1990],
      ["January", 1, 2, null],
      ["October", 10, 1, null],
      ["Leap", 2, 29, null],
    ] as const;
    for (const [name, month, day, year] of people) {
      await db.insertContact({
        userId: nay.id,
        fullName: name,
        email: "",
        phone: "",
        department: "IT",
        jobTitle: "",
        location: "",
        telegramUsername: "",
        notes: "",
        birthDay: day,
        birthMonth: month,
        birthYear: year,
        birthdayReminder: "day_before",
        createdAt: NOW,
      });
    }
    const upcoming = await listBirthdayEntries(deps, nay, "upcoming");
    expect(upcoming.map((entry) => entry.name)).toEqual(["November", "January", "Leap", "October"]);
    expect(upcoming[0]?.when).toBe("In 3 days");
    expect(upcoming[0]?.age).toBe(36);
    expect(upcoming[1]?.age).toBeNull();
    expect(calendarBirthday(2027, 2, 29, ZONE).day).toBe(28);
    expect(calendarBirthday(2028, 2, 29, ZONE).day).toBe(29);

    const parsed = contactSchema.safeParse({
      full_name: "Aung Min",
      birthday: { day: "18", month: "11", year: "" },
      birthday_reminder: "day_before",
    });
    if (!parsed.success) throw new Error("contact did not parse");
    const aung = await saveFormRecord(deps, nay, "contact", parsed.data);
    expect(aung.summary).toBe("Aung Min");
    const created = (await db.listReminders(nay.id)).find((reminder) => reminder.status === "active" && reminder.dedupeKey.startsWith("birthday:"));
    expect(created?.message).toBe("Aung Min's birthday is tomorrow (18 November).");
    expect(DateTime.fromISO(created?.nextRunAt ?? "", { setZone: true }).setZone(ZONE).toFormat("yyyy-LL-dd HH:mm")).toBe("2026-11-17 09:00");

    const stored = (await db.listContacts(nay.id)).find((contact) => contact.fullName === "Aung Min");
    if (!stored) throw new Error("missing contact");
    stored.birthdayReminder = "on_the_day";
    await db.updateContact(stored);
    await syncBirthdayReminder(deps, stored);
    const updated = (await db.listReminders(nay.id)).find((reminder) => reminder.dedupeKey === `birthday:${stored.id}`);
    expect(updated?.message).toBe("Aung Min's birthday is today (18 November).");
    expect(DateTime.fromISO(updated?.nextRunAt ?? "").setZone(ZONE).toFormat("yyyy-LL-dd HH:mm")).toBe("2026-11-18 09:00");

    stored.birthdayReminder = "none";
    await db.updateContact(stored);
    await syncBirthdayReminder(deps, stored);
    expect((await db.listReminders(nay.id)).find((reminder) => reminder.dedupeKey === `birthday:${stored.id}`)?.status).toBe("cancelled");

    stored.birthdayReminder = "day_before";
    stored.deletedAt = null;
    await db.updateContact(stored);
    await syncBirthdayReminder(deps, stored);
    const deleted = await db.deleteContact(nay.id, stored.id, NOW);
    if (!deleted) throw new Error("contact was not deleted");
    await syncBirthdayReminder(deps, deleted);
    expect((await db.listReminders(nay.id)).find((reminder) => reminder.dedupeKey === `birthday:${stored.id}`)?.status).toBe("cancelled");

    const month = await handleText(deps, nay, "Whose birthday is this month?");
    expect(month.text).toContain("October");
    expect(month.text).not.toContain("November");
  });
});
