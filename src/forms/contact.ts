import { schemaFor, type FieldDefinition, type FormDefinition } from "./definition.js";

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
  { name: "location", label: "Location", type: "text", required: false, placeholder: "Floor 2", maxLength: 200 },
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

export const contactForm: FormDefinition = {
  id: "contact",
  title: "Add contact",
  submitLabel: "Save contact",
  fields: contactFields,
};

export const contactSchema = schemaFor(contactFields);
