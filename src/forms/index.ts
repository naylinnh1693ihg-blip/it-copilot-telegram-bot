import { contactForm } from "./contact.js";
import { equipmentForm } from "./equipment.js";
import { linkForm } from "./link.js";
import type { FormDefinition } from "./definition.js";

export const FORMS: readonly FormDefinition[] = [equipmentForm, contactForm, linkForm];

export function findForm(id: string): FormDefinition | null {
  return FORMS.find((form) => form.id === id) ?? null;
}

export { contactForm, contactSchema } from "./contact.js";
export { equipmentForm, equipmentSchema } from "./equipment.js";
export { linkForm, linkSchema } from "./link.js";
export { SECRET_MESSAGE, parseForm, publicForm, schemaFor } from "./definition.js";
