import { bookForm } from "./book.js";
import { contactForm } from "./contact.js";
import { equipmentForm } from "./equipment.js";
import { ipForm } from "./ipAddress.js";
import { linkForm } from "./link.js";
import { locationForm } from "./location.js";
import type { FormDefinition } from "./definition.js";

export const FORMS: readonly FormDefinition[] = [equipmentForm, contactForm, linkForm, bookForm, locationForm, ipForm];

export function findForm(id: string): FormDefinition | null {
  return FORMS.find((form) => form.id === id) ?? null;
}

export { bookForm, bookSchema } from "./book.js";
export { contactForm, contactSchema } from "./contact.js";
export { equipmentForm, equipmentSchema } from "./equipment.js";
export { ipForm, ipSchema } from "./ipAddress.js";
export { linkForm, linkSchema } from "./link.js";
export { locationForm, locationSchema } from "./location.js";
export { SECRET_MESSAGE, parseForm, publicForm, schemaFor } from "./definition.js";
