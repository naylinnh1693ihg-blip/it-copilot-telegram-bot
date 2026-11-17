import { describe, expect, it } from "vitest";
import { contactSchema } from "../src/forms/contact.js";
import { SECRET_MESSAGE } from "../src/forms/definition.js";
import { equipmentSchema } from "../src/forms/equipment.js";
import { linkSchema } from "../src/forms/link.js";

const equipment = {
  name: "Dell Latitude 5440",
  kind: "laptop",
  status: "in_use",
  location: "Floor 2",
  ip_address: "192.168.1.10",
  serial_number: "SN-DL5440-100",
  purchase_date: "2024-03-01",
  warranty_end: "2027-03-01",
  notes: "Spare charger is in the cabinet.",
};

const contact = {
  full_name: "Ada Lovelace",
  email: "ada@example.com",
  phone: "+971 50 123 4567",
  department: "Finance",
  job_title: "Accountant",
  location: "Floor 2",
  telegram_username: "ada",
  notes: "Prefers a morning visit.",
};

const link = {
  title: "Firewall admin guide",
  url: "https://docs.vendor.com/firewall",
  category: "documentation",
  tags: "network, firewall",
  description: "How to reset the branch firewall.",
};

function errorsOf(result: { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } }): Record<string, string> {
  const errors: Record<string, string> = {};
  if (result.success || !result.error) return errors;
  for (const issue of result.error.issues) {
    const key = String(issue.path[0] ?? "form");
    if (!errors[key]) errors[key] = issue.message;
  }
  return errors;
}

describe("equipment form", () => {
  it("accepts a complete card", () => {
    const parsed = equipmentSchema.safeParse(equipment);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.name).toBe("Dell Latitude 5440");
  });

  it("reports each missing required field", () => {
    expect(errorsOf(equipmentSchema.safeParse({ ...equipment, name: "" })).name).toBe("Enter a name, such as Dell Latitude 5440.");
    expect(errorsOf(equipmentSchema.safeParse({ ...equipment, kind: "" })).kind).toBe("Choose a type.");
  });

  it("rejects a bad IP, a bad date, and a secret", () => {
    expect(errorsOf(equipmentSchema.safeParse({ ...equipment, ip_address: "999.1.1.1" })).ip_address).toMatch(/192\.168\.1\.10/);
    expect(errorsOf(equipmentSchema.safeParse({ ...equipment, purchase_date: "2024-02-31" })).purchase_date).toMatch(/2024-03-01/);
    expect(errorsOf(equipmentSchema.safeParse({ ...equipment, notes: "password: hunter2" })).notes).toBe(SECRET_MESSAGE);
  });

  it("trims the name and keeps a blank IP", () => {
    const parsed = equipmentSchema.safeParse({ ...equipment, name: "  Dell Latitude 5440  ", ip_address: "  " });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.name).toBe("Dell Latitude 5440");
    expect(parsed.data.ip_address).toBe("");
    expect(parsed.data.status).toBe("in_use");
  });
});

describe("contact form", () => {
  it("accepts a contact", () => {
    expect(contactSchema.safeParse(contact).success).toBe(true);
  });

  it("reports a missing name", () => {
    expect(errorsOf(contactSchema.safeParse({ ...contact, full_name: "  " })).full_name).toBe("Enter the person's name.");
  });

  it("rejects a bad email and a secret", () => {
    expect(errorsOf(contactSchema.safeParse({ ...contact, email: "ada@" })).email).toMatch(/ada@example.com/);
    expect(errorsOf(contactSchema.safeParse({ ...contact, notes: "api_key: abcdefghijklmnop" })).notes).toBe(SECRET_MESSAGE);
  });

  it("lowercases the email", () => {
    const parsed = contactSchema.safeParse({ ...contact, email: "  Ada@Example.COM " });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.email).toBe("ada@example.com");
  });
});

describe("link form", () => {
  it("accepts a link", () => {
    const parsed = linkSchema.safeParse(link);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.tags).toEqual(["network", "firewall"]);
  });

  it("reports each missing required field", () => {
    expect(errorsOf(linkSchema.safeParse({ ...link, title: "" })).title).toBe("Enter a title, such as Firewall admin guide.");
    expect(errorsOf(linkSchema.safeParse({ ...link, url: "" })).url).toBe("Enter a full address that starts with https://.");
    expect(errorsOf(linkSchema.safeParse({ ...link, category: "" })).category).toBe("Choose a category.");
  });

  it("rejects a bad URL and a secret", () => {
    expect(errorsOf(linkSchema.safeParse({ ...link, url: "docs.vendor.com/firewall" })).url).toMatch(/https:\/\//);
    expect(errorsOf(linkSchema.safeParse({ ...link, description: "-----BEGIN PRIVATE KEY-----\nabc" })).description).toBe(SECRET_MESSAGE);
  });

  it("strips tracking parameters and lowercases tags", () => {
    const parsed = linkSchema.safeParse({
      ...link,
      url: "https://docs.vendor.com/firewall?utm_source=newsletter&id=3",
      tags: "Network, VLAN",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.url).toBe("https://docs.vendor.com/firewall?id=3");
    expect(parsed.data.tags).toEqual(["network", "vlan"]);
  });
});
