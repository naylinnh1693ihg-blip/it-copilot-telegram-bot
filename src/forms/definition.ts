import { z } from "zod";
import { IPV4 } from "../utils/net.js";
import { cleanText, secretRisk } from "../utils/text.js";
import { birthdayPartsOk, normalizeIsbn, normalizeMac, parseCidr } from "./checks.js";
import { COUNTRIES, isCountryCode } from "./countries.js";

export const SECRET_MESSAGE = "This looks like a secret. Don't store credentials here.";

export const FIELD_TYPES = [
  "text",
  "textarea",
  "email",
  "url",
  "tel",
  "date",
  "select",
  "tags",
  "ipv4",
  "ref",
  "isbn",
  "cidr",
  "mac",
  "vlan",
  "country",
  "day_month",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface FieldOption {
  value: string;
  label: string;
}

export interface FieldDefinition {
  name: string;
  label: string;
  type: FieldType;
  required: boolean;
  placeholder: string;
  maxLength: number;
  options?: FieldOption[];
  /** Selected when the field is omitted. */
  default?: string;
  /** Desktop admin layout: this field spans both columns. */
  wide?: boolean;
  requiredMessage?: string;
  /** Hide this field unless another field has this value. Hidden fields are cleared before save. */
  showWhen?: { field: string; equals: string };
  /** Record form that fills a ref dropdown. */
  refForm?: string;
  /** Field on that form used as the option label. */
  refLabel?: string;
}

export interface FormDefinition {
  id: string;
  title: string;
  submitLabel: string;
  fields: FieldDefinition[];
  /** Admin list accepts a subnet query as well as text search. */
  subnetFilter?: boolean;
}

export type FormValue = string | string[] | null;
export type FormData = Record<string, FormValue>;

const DATE_MESSAGE = "Enter a real date as YYYY-MM-DD, such as 2024-03-01.";
const URL_MESSAGE = "Enter a full address that starts with https://, such as https://docs.vendor.com/firewall.";
const IP_MESSAGE = "Enter an IPv4 address like 192.168.1.10, or leave it blank.";
const EMAIL_MESSAGE = "Enter an email address like ada@example.com.";

function rejectSecret(value: string, ctx: z.RefinementCtx): void {
  if (secretRisk(value)) ctx.addIssue({ code: "custom", message: SECRET_MESSAGE });
}

function tooLong(label: string, maxLength: number): string {
  return `${label} must be ${maxLength} characters or fewer.`;
}

export function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map((part) => Number(part));
  if (!year || !month || !day) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** http(s) only. Drops utm_* query parameters. Returns null when the address is not usable. */
export function normalizeUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_")) url.searchParams.delete(key);
  }
  url.hash = "";
  return url.toString();
}

export function normalizeTags(value: string): { ok: true; tags: string[] } | { ok: false; message: string } {
  const tags: string[] = [];
  for (const part of value.split(",")) {
    const tag = cleanText(part, 80).toLowerCase();
    if (!tag) continue;
    if (tag.length > 40) return { ok: false, message: "Each tag must be 40 characters or fewer." };
    tags.push(tag);
  }
  if (tags.length > 10) return { ok: false, message: "Enter up to 10 tags, separated by commas." };
  if (secretRisk(tags.join(" "))) return { ok: false, message: SECRET_MESSAGE };
  return { ok: true, tags };
}

function textSchema(field: FieldDefinition) {
  const missing = field.requiredMessage ?? `Enter ${field.label.toLowerCase()}.`;
  return z.string({ error: missing }).trim().superRefine((value, ctx) => {
    if (!value) {
      if (field.required) ctx.addIssue({ code: "custom", message: missing });
      return;
    }
    if (value.length > field.maxLength) ctx.addIssue({ code: "custom", message: tooLong(field.label, field.maxLength) });
    rejectSecret(value, ctx);
  });
}

function emailSchema(field: FieldDefinition) {
  return z
    .string({ error: EMAIL_MESSAGE })
    .trim()
    .superRefine((value, ctx) => {
      if (!value) {
        if (field.required) ctx.addIssue({ code: "custom", message: EMAIL_MESSAGE });
        return;
      }
      if (value.length > field.maxLength) ctx.addIssue({ code: "custom", message: tooLong(field.label, field.maxLength) });
      rejectSecret(value, ctx);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) ctx.addIssue({ code: "custom", message: EMAIL_MESSAGE });
    })
    .transform((value) => value.toLowerCase());
}

function urlSchema(field: FieldDefinition) {
  const missing = field.requiredMessage ?? URL_MESSAGE;
  return z
    .string({ error: missing })
    .trim()
    .superRefine((value, ctx) => {
      if (!value) {
        if (field.required) ctx.addIssue({ code: "custom", message: missing });
        return;
      }
      if (value.length > field.maxLength) ctx.addIssue({ code: "custom", message: tooLong(field.label, field.maxLength) });
      rejectSecret(value, ctx);
      if (!normalizeUrl(value)) ctx.addIssue({ code: "custom", message: URL_MESSAGE });
    })
    .transform((value) => (value ? normalizeUrl(value) ?? "" : ""));
}

function dateSchema(field: FieldDefinition) {
  const missing = field.requiredMessage ?? DATE_MESSAGE;
  return z
    .string({ error: missing })
    .trim()
    .superRefine((value, ctx) => {
      if (!value) {
        if (field.required) ctx.addIssue({ code: "custom", message: missing });
        return;
      }
      if (!isRealDate(value)) ctx.addIssue({ code: "custom", message: DATE_MESSAGE });
    })
    .transform((value) => (value ? value : null));
}

function ipv4Schema(field: FieldDefinition) {
  const missing = field.requiredMessage ?? IP_MESSAGE;
  return z.string({ error: missing }).trim().superRefine((value, ctx) => {
    if (!value) {
      if (field.required) ctx.addIssue({ code: "custom", message: missing });
      return;
    }
    if (!IPV4.test(value)) ctx.addIssue({ code: "custom", message: IP_MESSAGE });
  });
}

function selectSchema(field: FieldDefinition) {
  const allowed = new Set((field.options ?? []).map((option) => option.value));
  const missing = field.requiredMessage ?? `Choose a ${field.label.toLowerCase()}.`;
  return z.string({ error: missing }).trim().superRefine((value, ctx) => {
    if (!value || !allowed.has(value)) ctx.addIssue({ code: "custom", message: missing });
  });
}

function tagsSchema() {
  return z
    .union([z.string(), z.array(z.string())], { error: "Enter tags separated by commas." })
    .transform((value) => (Array.isArray(value) ? value.join(",") : value))
    .superRefine((value, ctx) => {
      const parsed = normalizeTags(value);
      if (!parsed.ok) ctx.addIssue({ code: "custom", message: parsed.message });
    })
    .transform((value) => {
      const parsed = normalizeTags(value);
      return parsed.ok ? parsed.tags : [];
    });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function optionalText(field: FieldDefinition, check: (value: string, ctx: z.RefinementCtx) => void, transform?: (value: string) => string) {
  const missing = field.requiredMessage ?? `Enter ${field.label.toLowerCase()}.`;
  return z
    .string({ error: missing })
    .trim()
    .superRefine((value, ctx) => {
      if (!value) {
        if (field.required) ctx.addIssue({ code: "custom", message: missing });
        return;
      }
      if (value.length > field.maxLength) ctx.addIssue({ code: "custom", message: tooLong(field.label, field.maxLength) });
      rejectSecret(value, ctx);
      check(value, ctx);
    })
    .transform((value) => (transform ? transform(value) : value));
}

function isbnSchema(field: FieldDefinition) {
  return optionalText(field, (value, ctx) => {
    if (!normalizeIsbn(value)) ctx.addIssue({ code: "custom", message: "Enter a valid ISBN-10 or ISBN-13. The checksum did not match." });
  }, (value) => (value ? normalizeIsbn(value) ?? "" : ""));
}

function cidrSchema(field: FieldDefinition) {
  return optionalText(field, (value, ctx) => {
    if (!parseCidr(value)) ctx.addIssue({ code: "custom", message: "Enter a subnet like 192.168.1.0/24." });
  }, (value) => (value ? parseCidr(value) ?? "" : ""));
}

function macSchema(field: FieldDefinition) {
  return optionalText(field, (value, ctx) => {
    if (!normalizeMac(value)) ctx.addIssue({ code: "custom", message: "Enter a MAC address like AA:BB:CC:DD:EE:FF." });
  }, (value) => (value ? normalizeMac(value) ?? "" : ""));
}

function vlanSchema(field: FieldDefinition) {
  const missing = field.requiredMessage ?? "Enter a VLAN from 1 to 4094, or leave it blank.";
  return z
    .union([z.string(), z.number()], { error: missing })
    .transform((value) => String(value).trim())
    .superRefine((value, ctx) => {
      if (!value) {
        if (field.required) ctx.addIssue({ code: "custom", message: missing });
        return;
      }
      if (!/^\d+$/.test(value)) {
        ctx.addIssue({ code: "custom", message: "Enter a VLAN from 1 to 4094, or leave it blank." });
        return;
      }
      const vlan = Number(value);
      if (vlan < 1 || vlan > 4094) ctx.addIssue({ code: "custom", message: "Enter a VLAN from 1 to 4094, or leave it blank." });
    });
}

function countrySchema(field: FieldDefinition) {
  const missing = field.requiredMessage ?? "Choose a country.";
  return z
    .string({ error: missing })
    .trim()
    .transform((value) => value.toUpperCase())
    .superRefine((value, ctx) => {
      if (!value) {
        if (field.required) ctx.addIssue({ code: "custom", message: missing });
        return;
      }
      if (!isCountryCode(value)) ctx.addIssue({ code: "custom", message: "Choose a country from the list." });
    });
}

function refSchema(field: FieldDefinition) {
  const missing = field.requiredMessage ?? `Choose a ${field.label.toLowerCase()}.`;
  return z.string({ error: missing }).trim().superRefine((value, ctx) => {
    if (!value) {
      if (field.required) ctx.addIssue({ code: "custom", message: missing });
      return;
    }
    if (!UUID.test(value)) ctx.addIssue({ code: "custom", message: "Choose a record from your own list." });
  });
}

function dayMonthSchema(_field: FieldDefinition) {
  return z
    .union([z.string(), z.object({ day: z.unknown(), month: z.unknown(), year: z.unknown() }).partial()], { error: "Enter the day and month, or leave the birthday blank." })
    .transform((value) => {
      if (typeof value === "string") {
        if (!value.trim()) return "";
        const [day, month, year] = value.split("|");
        return packBirthday(day ?? "", month ?? "", year ?? "");
      }
      return packBirthday(String(value.day ?? ""), String(value.month ?? ""), String(value.year ?? ""));
    })
    .superRefine((value, ctx) => {
      if (!value) return;
      const [dayText, monthText, yearText] = value.split("|");
      const day = dayText ? Number(dayText) : null;
      const month = monthText ? Number(monthText) : null;
      const year = yearText ? Number(yearText) : null;
      if (!dayText && !monthText && !yearText) return;
      if (!dayText || !monthText || !Number.isInteger(day) || !Number.isInteger(month) || (yearText && !Number.isInteger(year))) {
        ctx.addIssue({ code: "custom", message: "Enter the day and month, or leave the birthday blank." });
        return;
      }
      if (!birthdayPartsOk(day, month, yearText ? year : null)) {
        ctx.addIssue({
          code: "custom",
          message: month === 2 && day === 29 ? "29 February needs a leap year, or leave the year blank." : "That day does not exist in that month.",
        });
      }
    });
}

function packBirthday(day: string, month: string, year: string): string {
  const d = day.trim();
  const m = month.trim();
  const y = year.trim();
  if (!d && !m && !y) return "";
  return `${d}|${m}|${y}`;
}

function rawFieldSchema(field: FieldDefinition): z.ZodType<FormValue> {
  switch (field.type) {
    case "email":
      return emailSchema(field);
    case "url":
      return urlSchema(field);
    case "date":
      return dateSchema(field);
    case "ipv4":
      return ipv4Schema(field);
    case "select":
      return selectSchema(field);
    case "tags":
      return tagsSchema();
    case "isbn":
      return isbnSchema(field);
    case "cidr":
      return cidrSchema(field);
    case "mac":
      return macSchema(field);
    case "vlan":
      return vlanSchema(field);
    case "country":
      return countrySchema(field);
    case "ref":
      return refSchema(field);
    case "day_month":
      return dayMonthSchema(field);
    case "text":
    case "textarea":
    case "tel":
      return textSchema(field);
    default: {
      const never: never = field.type;
      return never;
    }
  }
}

/** A missing optional key, or a select with a default, is filled in before checks run. */
function fieldSchema(field: FieldDefinition): z.ZodType<FormValue> {
  const schema = rawFieldSchema(field);
  if (field.required && !field.default) return schema;
  const fill = field.default ?? "";
  return z.preprocess((value) => (value == null ? fill : value), schema);
}

export function schemaFor(fields: FieldDefinition[]): z.ZodType<FormData> {
  const shape: Record<string, z.ZodType<FormValue>> = {};
  for (const field of fields) shape[field.name] = fieldSchema(field);
  return z.object(shape);
}

export function fieldErrors(error: z.ZodError): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = typeof issue.path[0] === "string" ? issue.path[0] : "form";
    if (!errors[key]) errors[key] = issue.message;
  }
  return errors;
}

export function parseForm(fields: FieldDefinition[], body: unknown): { ok: true; data: FormData } | { ok: false; errors: Record<string, string> } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, errors: { form: "Send the form fields as JSON." } };
  }
  const parsed = schemaFor(fields).safeParse(body);
  if (!parsed.success) return { ok: false, errors: fieldErrors(parsed.error) };
  return { ok: true, data: parsed.data };
}

export function publicForm(form: FormDefinition): FormDefinition {
  return {
    id: form.id,
    title: form.title,
    submitLabel: form.submitLabel,
    fields: form.fields.map((field) => ({
      name: field.name,
      label: field.label,
      type: field.type,
      required: field.required,
      placeholder: field.placeholder,
      maxLength: field.maxLength,
      ...(field.options ? { options: field.options } : {}),
      ...(field.default ? { default: field.default } : {}),
      ...(field.wide ? { wide: true } : {}),
      ...(field.requiredMessage ? { requiredMessage: field.requiredMessage } : {}),
      ...(field.showWhen ? { showWhen: field.showWhen } : {}),
      ...(field.refForm ? { refForm: field.refForm, refLabel: field.refLabel } : {}),
      ...(field.type === "country" ? { options: COUNTRIES.map((country) => ({ value: country.code, label: country.name })) } : {}),
    })),
    ...(form.subnetFilter ? { subnetFilter: true } : {}),
  };
}

export function textValue(data: FormData, name: string): string {
  const value = data[name];
  return typeof value === "string" ? value : "";
}

export function tagsValue(data: FormData, name: string): string[] {
  const value = data[name];
  return Array.isArray(value) ? value.filter((tag) => typeof tag === "string") : [];
}

export function dateValue(data: FormData, name: string): string | null {
  const value = data[name];
  return typeof value === "string" && value ? value : null;
}

export function birthdayValue(data: FormData, name: string): { day: number | null; month: number | null; year: number | null } {
  const value = textValue(data, name);
  if (!value) return { day: null, month: null, year: null };
  const [day, month, year] = value.split("|");
  return {
    day: day ? Number(day) : null,
    month: month ? Number(month) : null,
    year: year ? Number(year) : null,
  };
}

export function idValue(data: FormData, name: string): string | null {
  const value = textValue(data, name);
  return value || null;
}
