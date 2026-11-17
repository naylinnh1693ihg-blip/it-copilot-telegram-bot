import { schemaFor, type FieldDefinition, type FormDefinition } from "./definition.js";
import { cidrContains } from "./checks.js";

const KINDS = [
  { value: "static", label: "Static" },
  { value: "dhcp_reservation", label: "DHCP reservation" },
  { value: "gateway", label: "Gateway" },
  { value: "dns", label: "DNS" },
  { value: "reserved", label: "Reserved" },
];

export const ipFields: FieldDefinition[] = [
  {
    name: "ip",
    label: "IP address",
    type: "ipv4",
    required: true,
    placeholder: "192.168.1.10",
    maxLength: 15,
    requiredMessage: "Enter an IPv4 address like 192.168.1.10.",
  },
  { name: "subnet", label: "Subnet", type: "cidr", required: false, placeholder: "192.168.1.0/24", maxLength: 18 },
  { name: "vlan", label: "VLAN", type: "vlan", required: false, placeholder: "10", maxLength: 4 },
  { name: "hostname", label: "Hostname", type: "text", required: false, placeholder: "sw-floor2", maxLength: 200 },
  { name: "mac_address", label: "MAC address", type: "mac", required: false, placeholder: "AA:BB:CC:DD:EE:FF", maxLength: 17 },
  {
    name: "kind",
    label: "Type",
    type: "select",
    required: true,
    placeholder: "Static",
    maxLength: 20,
    default: "static",
    requiredMessage: "Choose a type.",
    options: KINDS,
  },
  {
    name: "equipment_id",
    label: "Device",
    type: "ref",
    required: false,
    placeholder: "None",
    maxLength: 36,
    refForm: "equipment",
    refLabel: "name",
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
  { name: "notes", label: "Notes", type: "textarea", required: false, placeholder: "Printer port.", maxLength: 2000, wide: true },
];

export const ipForm: FormDefinition = {
  id: "ip",
  title: "Add IP address",
  submitLabel: "Save IP address",
  fields: ipFields,
  subnetFilter: true,
};

export const ipSchema = schemaFor(ipFields).superRefine((data, ctx) => {
  const ip = typeof data.ip === "string" ? data.ip : "";
  const subnet = typeof data.subnet === "string" ? data.subnet : "";
  if (ip && subnet && !cidrContains(ip, subnet)) {
    ctx.addIssue({ code: "custom", path: ["ip"], message: `${ip} is not inside ${subnet}.` });
  }
});
