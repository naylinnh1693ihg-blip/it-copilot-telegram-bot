import { schemaFor, type FieldDefinition, type FormDefinition } from "./definition.js";

const KINDS = [
  { value: "site", label: "Site" },
  { value: "building", label: "Building" },
  { value: "floor", label: "Floor" },
  { value: "room", label: "Room" },
  { value: "data_center", label: "Data center" },
  { value: "remote", label: "Remote" },
];

export const locationFields: FieldDefinition[] = [
  {
    name: "name",
    label: "Name",
    type: "text",
    required: true,
    placeholder: "Floor 2",
    maxLength: 200,
    requiredMessage: "Enter a name, such as Floor 2.",
  },
  {
    name: "kind",
    label: "Kind",
    type: "select",
    required: true,
    placeholder: "Floor",
    maxLength: 20,
    requiredMessage: "Choose a kind.",
    options: KINDS,
  },
  {
    name: "parent_location_id",
    label: "Parent",
    type: "ref",
    required: false,
    placeholder: "None",
    maxLength: 36,
    refForm: "location",
    refLabel: "name",
  },
  { name: "street_address", label: "Street address", type: "text", required: false, placeholder: "1 Harbour Road", maxLength: 200 },
  {
    name: "city",
    label: "City",
    type: "text",
    required: true,
    placeholder: "Dubai",
    maxLength: 120,
    requiredMessage: "Enter a city, such as Dubai.",
  },
  {
    name: "country",
    label: "Country",
    type: "country",
    required: true,
    placeholder: "United Arab Emirates",
    maxLength: 2,
    requiredMessage: "Choose a country.",
  },
  { name: "postal_code", label: "Postal code", type: "text", required: false, placeholder: "00000", maxLength: 20 },
  { name: "map_url", label: "Map link", type: "url", required: false, placeholder: "https://maps.example.com/floor-2", maxLength: 2000, wide: true },
  {
    name: "site_contact_id",
    label: "Site contact",
    type: "ref",
    required: false,
    placeholder: "None",
    maxLength: 36,
    refForm: "contact",
    refLabel: "full_name",
  },
  { name: "notes", label: "Notes", type: "textarea", required: false, placeholder: "Server room is behind reception.", maxLength: 2000, wide: true },
];

export const locationForm: FormDefinition = {
  id: "location",
  title: "Add location",
  submitLabel: "Save location",
  fields: locationFields,
};

export const locationSchema = schemaFor(locationFields);
