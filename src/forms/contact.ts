import { schemaFor, type FieldDefinition, type FormDefinition } from "./definition.js";

const REMINDER_OPTIONS = [
  { value: "day_before", label: "Day before" },
  { value: "on_the_day", label: "On the day" },
  { value: "none", label: "None" },
];

export const contactFields: FieldDefinition[] = [
  {
    name: "full_name",
    label: "Full name",
    type: "text",
    required: true,
    placeholder: "Ada Lovelace",
    maxLength: 200,
    requiredMessage: "Enter the person's name.",
  },
  { name: "email", label: "Email", type: "email", required: false, placeholder: "ada@example.com", maxLength: 200 },
  { name: "phone", label: "Phone", type: "tel", required: false, placeholder: "+971 50 123 4567", maxLength: 40 },
  { name: "department", label: "Department", type: "text", required: false, placeholder: "Finance", maxLength: 120 },
  { name: "job_title", label: "Job title", type: "text", required: false, placeholder: "Accountant", maxLength: 120 },
  { name: "telegram_username", label: "Telegram username", type: "text", required: false, placeholder: "ada", maxLength: 32 },
  {
    name: "notes",
    label: "Notes",
    type: "textarea",
    required: false,
    placeholder: "Prefers a morning visit.",
    maxLength: 2000,
    wide: true,
  },
];

contactFields.push(
  {
    name: "location_id",
    label: "Location",
    type: "ref",
    required: false,
    placeholder: "None",
    maxLength: 36,
    refForm: "location",
    refLabel: "name",
  },
  {
    name: "birthday",
    label: "Birthday",
    type: "day_month",
    required: false,
    placeholder: "18 November",
    maxLength: 10,
  },
  {
    name: "birthday_reminder",
    label: "Birthday reminder",
    type: "select",
    required: true,
    placeholder: "Day before",
    maxLength: 20,
    default: "day_before",
    requiredMessage: "Choose when to be reminded.",
    options: REMINDER_OPTIONS,
  },
);

export const contactForm: FormDefinition = {
  id: "contact",
  title: "Add user information",
  submitLabel: "Save user",
  fields: contactFields,
};

export const contactSchema = schemaFor(contactFields);
