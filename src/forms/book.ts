import { schemaFor, type FieldDefinition, type FormDefinition } from "./definition.js";

const CATEGORIES = [
  { value: "networking", label: "Networking" },
  { value: "security", label: "Security" },
  { value: "cloud", label: "Cloud" },
  { value: "programming", label: "Programming" },
  { value: "management", label: "Management" },
  { value: "other", label: "Other" },
];

const FORMATS = [
  { value: "physical", label: "Physical" },
  { value: "ebook", label: "Ebook" },
  { value: "pdf", label: "PDF" },
  { value: "audiobook", label: "Audiobook" },
];

const STATUSES = [
  { value: "to_read", label: "To read" },
  { value: "reading", label: "Reading" },
  { value: "finished", label: "Finished" },
  { value: "lent_out", label: "Lent out" },
];

export const bookFields: FieldDefinition[] = [
  {
    name: "title",
    label: "Title",
    type: "text",
    required: true,
    placeholder: "Computer Networks",
    maxLength: 300,
    requiredMessage: "Enter a title, such as Computer Networks.",
  },
  {
    name: "author",
    label: "Author",
    type: "text",
    required: true,
    placeholder: "Andrew Tanenbaum",
    maxLength: 200,
    requiredMessage: "Enter an author.",
  },
  { name: "isbn", label: "ISBN", type: "isbn", required: false, placeholder: "9780131103627", maxLength: 20 },
  { name: "publisher", label: "Publisher", type: "text", required: false, placeholder: "Pearson", maxLength: 200 },
  { name: "year", label: "Year", type: "text", required: false, placeholder: "2021", maxLength: 4 },
  {
    name: "category",
    label: "Category",
    type: "select",
    required: true,
    placeholder: "Networking",
    maxLength: 20,
    requiredMessage: "Choose a category.",
    options: CATEGORIES,
  },
  {
    name: "format",
    label: "Format",
    type: "select",
    required: true,
    placeholder: "Physical",
    maxLength: 20,
    requiredMessage: "Choose a format.",
    options: FORMATS,
  },
  {
    name: "status",
    label: "Status",
    type: "select",
    required: true,
    placeholder: "To read",
    maxLength: 20,
    default: "to_read",
    requiredMessage: "Choose a status.",
    options: STATUSES,
  },
  {
    name: "lent_to_contact_id",
    label: "Lent to",
    type: "ref",
    required: false,
    placeholder: "None",
    maxLength: 36,
    refForm: "contact",
    refLabel: "full_name",
    showWhen: { field: "status", equals: "lent_out" },
  },
  {
    name: "lent_on",
    label: "Lent on",
    type: "date",
    required: false,
    placeholder: "2026-11-01",
    maxLength: 10,
    showWhen: { field: "status", equals: "lent_out" },
  },
  { name: "notes", label: "Notes", type: "textarea", required: false, placeholder: "Copy on the office shelf.", maxLength: 2000, wide: true },
];

export const bookForm: FormDefinition = {
  id: "book",
  title: "Add book",
  submitLabel: "Save book",
  fields: bookFields,
};

export function maxBookYear(now = new Date()): number {
  return now.getUTCFullYear() + 1;
}

export const bookSchema = schemaFor(bookFields).superRefine((data, ctx) => {
  const year = typeof data.year === "string" ? data.year.trim() : "";
  if (year) {
    const value = Number(year);
    const max = maxBookYear();
    if (!/^\d{4}$/.test(year) || value < 1450 || value > max) {
      ctx.addIssue({ code: "custom", path: ["year"], message: `Enter a year from 1450 to ${max}.` });
    }
  }
  const status = data.status;
  const lentTo = typeof data.lent_to_contact_id === "string" ? data.lent_to_contact_id : "";
  const lentOn = data.lent_on;
  if (status === "lent_out" && !lentTo) {
    ctx.addIssue({ code: "custom", path: ["lent_to_contact_id"], message: "Choose who has this book." });
  }
  if (status !== "lent_out" && (lentTo || lentOn)) {
    ctx.addIssue({ code: "custom", path: ["lent_to_contact_id"], message: "Clear Lent to and Lent on unless the status is Lent out." });
  }
});
