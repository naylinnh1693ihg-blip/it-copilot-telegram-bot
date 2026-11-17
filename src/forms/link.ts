import type { LinkCategory } from "../types/models.js";
import { LINK_CATEGORIES } from "../types/models.js";
import { schemaFor, type FieldDefinition, type FormDefinition } from "./definition.js";

const CATEGORY_LABEL: Record<LinkCategory, string> = {
  documentation: "Documentation",
  vendor_portal: "Vendor portal",
  tool: "Tool",
  troubleshooting: "Troubleshooting",
  other: "Other",
};

export const linkFields: FieldDefinition[] = [
  {
    name: "title",
    label: "Title",
    type: "text",
    required: true,
    placeholder: "Firewall admin guide",
    maxLength: 200,
    requiredMessage: "Enter a title, such as Firewall admin guide.",
  },
  {
    name: "url",
    label: "URL",
    type: "url",
    required: true,
    placeholder: "https://docs.vendor.com/firewall",
    maxLength: 2000,
    wide: true,
    requiredMessage: "Enter a full address that starts with https://.",
  },
  {
    name: "category",
    label: "Category",
    type: "select",
    required: true,
    placeholder: "Documentation",
    maxLength: 40,
    requiredMessage: "Choose a category.",
    options: LINK_CATEGORIES.map((value) => ({ value, label: CATEGORY_LABEL[value] })),
  },
  { name: "tags", label: "Tags", type: "tags", required: false, placeholder: "network, firewall", maxLength: 400 },
  {
    name: "description",
    label: "Description",
    type: "textarea",
    required: false,
    placeholder: "How to reset the branch firewall.",
    maxLength: 2000,
    wide: true,
  },
];

export const linkForm: FormDefinition = {
  id: "link",
  title: "Save website link",
  submitLabel: "Save link",
  fields: linkFields,
};

export const linkSchema = schemaFor(linkFields);
