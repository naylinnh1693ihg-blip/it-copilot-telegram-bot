import { z } from "zod";
import { IPV4 } from "../utils/net.js";
import { cleanText, secretRisk } from "../utils/text.js";

export const SECRET_MESSAGE = "This looks like a secret. Don't store credentials here.";

export const FIELD_TYPES = ["text", "textarea", "email", "url", "tel", "date", "select", "tags", "ipv4"] as const;
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
}

export interface FormDefinition {
  id: string;
  title: string;
  submitLabel: string;
  fields: FieldDefinition[];
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
    })),
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
