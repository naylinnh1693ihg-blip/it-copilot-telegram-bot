import type { EquipmentKind, EquipmentStatus } from "../types/models.js";
import { EQUIPMENT_KINDS, EQUIPMENT_STATUSES } from "../types/models.js";
import { schemaFor, type FieldDefinition, type FormDefinition } from "./definition.js";

const KIND_LABEL: Record<EquipmentKind, string> = {
  printer: "Printer",
  switch: "Switch",
  access_point: "Access point",
  laptop: "Laptop",
  monitor: "Monitor",
  server: "Server",
  other: "Other",
};

const STATUS_LABEL: Record<EquipmentStatus, string> = {
  in_use: "In use",
  in_stock: "In stock",
  in_repair: "In repair",
  retired: "Retired",
};

export const equipmentFields: FieldDefinition[] = [
  {
    name: "name",
    label: "Name",
    type: "text",
    required: true,
    placeholder: "Dell Latitude 5440",
    maxLength: 200,
    requiredMessage: "Enter a name, such as Dell Latitude 5440.",
  },
  {
    name: "kind",
    label: "Type",
    type: "select",
    required: true,
    placeholder: "Laptop",
    maxLength: 40,
    requiredMessage: "Choose a type.",
    options: EQUIPMENT_KINDS.map((value) => ({ value, label: KIND_LABEL[value] })),
  },
  {
    name: "status",
    label: "Status",
    type: "select",
    required: true,
    placeholder: "In use",
    maxLength: 20,
    default: "in_use",
    requiredMessage: "Choose a status.",
    options: EQUIPMENT_STATUSES.map((value) => ({ value, label: STATUS_LABEL[value] })),
  },
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
  { name: "ip_address", label: "IP address", type: "ipv4", required: false, placeholder: "192.168.1.10", maxLength: 15 },
  { name: "serial_number", label: "Serial number", type: "text", required: false, placeholder: "SN-DL5440-100", maxLength: 120 },
  { name: "purchase_date", label: "Purchase date", type: "date", required: false, placeholder: "2024-03-01", maxLength: 10 },
  { name: "warranty_end", label: "Warranty end", type: "date", required: false, placeholder: "2027-03-01", maxLength: 10 },
  {
    name: "notes",
    label: "Notes",
    type: "textarea",
    required: false,
    placeholder: "Spare charger is in the cabinet.",
    maxLength: 2000,
    wide: true,
  },
];

export const equipmentForm: FormDefinition = {
  id: "equipment",
  title: "Add equipment",
  submitLabel: "Save equipment",
  fields: equipmentFields,
};

export const equipmentSchema = schemaFor(equipmentFields);
