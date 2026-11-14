import { z } from "zod";
import type { Deps } from "../../app/deps.js";
import type { User, Equipment, EquipmentKind } from "../../types/models.js";
import { wrapUntrusted } from "../../utils/security.js";
import { secretRisk } from "../../utils/text.js";
import { toIso } from "../../utils/time.js";
import type { Reply } from "./execute.js";

const TYPE_LABEL: Record<EquipmentKind, string> = {
  printer: "Printer",
  switch: "Switch",
  access_point: "Access point",
  other: "Other",
};

const PLURAL: Record<EquipmentKind, string> = {
  printer: "Printers",
  switch: "Switches",
  access_point: "Access points",
  other: "Other equipment",
};

const CREATE =
  /^(?:please\s+)?(?:add|save|register)\s+(equipment|a printer|printer|a switch|switch|an access point|access point|ap)\b\s*[:-]?\s*([\s\S]*)$/i;
const LIST = /^(?:please\s+)?(?:list|show)(?:\s+all)?(?:\s+my)?\s+(equipment|printers|switches|access points|other equipment)$/i;
const SHOW_IP = /^(?:please\s+)?what(?:'s|s| is) the ip(?: address)? of\s+(.+?)\??$/i;
const SHOW = /^(?:please\s+)?show equipment\s+(.+)$/i;
const EXTRACT = /^(?:please\s+)?extract equipment from (note|document)\s+#?(\d+)$/i;
const UPDATE = /^(?:please\s+)?(?:update|set)\s+equipment\s+(.+?)\s*:\s*([\s\S]+)$/i;
const LABEL = /^(name|type|location|ip|notes|vendor|model|firmware(?:\s+version)?|version)\s*:\s*(.*)$/i;
const UPDATE_FIELD = /^(vendor|model|firmware(?:\s+version)?|version|location|ip|notes)(?:\s*[:=]\s*|\s+)(.+)$/i;
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const CREATE_EXAMPLE = "Add equipment: HP LaserJet, Floor 2, 192.168.1.10";
const UPDATE_EXAMPLE = "Update equipment Main switch: vendor Cisco, model C9300-48P, firmware 17.9.4";

const ExtractedEquipmentSchema = z.object({
  items: z
    .array(
      z.object({
        name: z.string().max(200),
        type: z.enum(["printer", "switch", "access_point", "other"]),
        location: z.string().max(200),
        ip: z.string().max(45),
        notes: z.string().max(2000),
        vendor: z.string().max(100).optional().default(""),
        model: z.string().max(100).optional().default(""),
        firmware: z.string().max(100).optional().default(""),
      }),
    )
    .max(15),
});

export const EQUIPMENT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      maxItems: 15,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "type", "location", "ip", "notes", "vendor", "model", "firmware"],
        properties: {
          name: { type: "string" },
          type: { type: "string", enum: ["printer", "switch", "access_point", "other"] },
          location: { type: "string" },
          ip: { type: "string" },
          notes: { type: "string" },
          vendor: { type: "string" },
          model: { type: "string" },
          firmware: { type: "string" },
        },
      },
    },
  },
} as const;

export interface EquipmentUpdate {
  vendor?: string;
  model?: string;
  firmware?: string;
  location?: string;
  ip?: string;
  notes?: string;
}

export type EquipmentCommand =
  | { action: "create"; name: string; kind: EquipmentKind; location: string; ip: string; notes: string; vendor: string; model: string; firmware: string }
  | { action: "update"; query: string; changes: EquipmentUpdate }
  | { action: "clarify"; question: string }
  | { action: "list"; kind: EquipmentKind | "all" }
  | { action: "show"; query: string }
  | { action: "extract"; source: "note" | "document"; number: number };

interface Draft {
  name: string;
  kind: EquipmentKind;
  location: string;
  ip: string;
  notes: string;
  vendor: string;
  model: string;
  firmware: string;
}

/** Clear equipment commands. Returns null when the message is about something else. */
export function parseEquipmentCommand(text: string): EquipmentCommand | null {
  const normalized = text.replace(/[.]+$/, "").trim();
  const extract = normalized.match(EXTRACT);
  if (extract?.[1] && extract[2]) {
    const source = extract[1].toLowerCase() === "document" ? "document" : "note";
    return { action: "extract", source, number: Number(extract[2]) };
  }

  const update = normalized.match(UPDATE);
  if (update?.[1] && update[2]) return parseUpdateBody(update[1].trim(), update[2]);

  const list = normalized.match(LIST);
  if (list?.[1]) return { action: "list", kind: listKind(list[1]) };

  const showIp = normalized.match(SHOW_IP);
  if (showIp?.[1]?.trim()) return { action: "show", query: showIp[1].trim() };

  const show = normalized.match(SHOW);
  if (show?.[1]?.trim()) return { action: "show", query: show[1].trim() };

  const create = normalized.match(CREATE);
  if (!create?.[1]) return null;
  const kind = kindFromWord(create[1]) ?? "other";
  return parseCreateBody(create[2] ?? "", kind);
}

export function formatEquipmentCard(item: Equipment, source: string | null): string {
  const lines = [
    `Equipment: ${item.name}`,
    `Type: ${TYPE_LABEL[item.kind]}`,
    `Location: ${item.location}`,
    `IP: ${item.ipAddress}`,
  ];
  if (item.vendor) lines.push(`Vendor: ${item.vendor}`);
  if (item.model) lines.push(`Model: ${item.model}`);
  if (item.firmwareVersion) lines.push(`Firmware: ${item.firmwareVersion}`);
  if (item.notes) lines.push(`Notes: ${item.notes}`);
  if (source) lines.push(`Source: ${source}`);
  return lines.join("\n");
}

export async function handleEquipment(deps: Deps, user: User, command: EquipmentCommand): Promise<Reply> {
  if (command.action === "extract") {
    if (!deps.llm) {
      return { text: `I can save a card directly. Try: ${CREATE_EXAMPLE}` };
    }
    deps.logger.info({ event: "intent_route", route: "grok", intent: "equipment_extract" }, "message sent to Grok");
    return extractEquipment(deps, user, command);
  }

  deps.logger.info(
    { event: "intent_route", route: "local", intent: "equipment", action: command.action },
    "equipment handled locally",
  );
  if (command.action === "clarify") return { text: command.question };
  if (command.action === "list") return listEquipment(deps, user, command.kind);
  if (command.action === "show") return showEquipment(deps, user, command.query);
  if (command.action === "update") return updateEquipment(deps, user, command.query, command.changes);
  return saveDraft(deps, user, command, null, null);
}

function parseCreateBody(body: string, fallback: EquipmentKind): EquipmentCommand {
  const trimmed = body.trim();
  if (!trimmed) {
    return { action: "clarify", question: `Tell me the name, location, and IP. Example: ${CREATE_EXAMPLE}` };
  }
  const labelled = fromLabels(trimmed, fallback);
  const lines = trimmed.split(/\n/).map((line) => line.trim()).filter(Boolean);
  const parsed = labelled ?? fromLines(lines, fallback) ?? fromCommas(trimmed.replace(/\s+/g, " "), fallback);
  if (!parsed) {
    return { action: "clarify", question: `I need a name, location, and IP. Example: ${CREATE_EXAMPLE}` };
  }
  if (!parsed.ip) {
    return { action: "clarify", question: `I need an IP address. Example: ${CREATE_EXAMPLE}` };
  }
  if (!isIp(parsed.ip)) {
    return { action: "clarify", question: `${parsed.ip} is not an IPv4 address. Example: ${CREATE_EXAMPLE}` };
  }
  if (!parsed.location) {
    return { action: "clarify", question: `I need a location. Example: ${CREATE_EXAMPLE}` };
  }
  const risk = secretRisk(draftText(parsed));
  if (risk) return { action: "clarify", question: `I didn't save that. It looks like a ${risk}.` };
  return { action: "create", ...parsed, kind: inferKind(parsed.name, parsed.kind), ip: parsed.ip };
}

function draftText(draft: Pick<Draft, "name" | "location" | "notes" | "vendor" | "model" | "firmware">): string {
  return [draft.name, draft.location, draft.notes, draft.vendor, draft.model, draft.firmware].join("\n");
}

function labelKey(label: string): keyof EquipmentUpdate | "name" | "type" {
  const key = label.toLowerCase().replace(/\s+/g, " ");
  if (key === "firmware" || key === "firmware version" || key === "version") return "firmware";
  return key as keyof EquipmentUpdate | "name" | "type";
}

function parseUpdateBody(query: string, body: string): EquipmentCommand {
  const changes: EquipmentUpdate = {};
  for (const part of body.split(/[\n,]/).map((piece) => piece.trim()).filter(Boolean)) {
    const match = part.match(UPDATE_FIELD);
    if (!match?.[1] || !match[2]) {
      return { action: "clarify", question: `I couldn't read "${part}". Example: ${UPDATE_EXAMPLE}` };
    }
    const key = labelKey(match[1]);
    if (key === "name" || key === "type") continue;
    changes[key] = clip(match[2], key === "notes" ? 2000 : key === "location" ? 200 : 100);
  }
  if (Object.keys(changes).length === 0) {
    return { action: "clarify", question: `Tell me what to change. Example: ${UPDATE_EXAMPLE}` };
  }
  if (changes.ip !== undefined && !isIp(changes.ip)) {
    return { action: "clarify", question: `${changes.ip} is not an IPv4 address. Nothing was changed.` };
  }
  const risk = secretRisk(Object.values(changes).join("\n"));
  if (risk) return { action: "clarify", question: `I didn't save that. It looks like a ${risk}.` };
  return { action: "update", query, changes };
}

async function updateEquipment(deps: Deps, user: User, query: string, changes: EquipmentUpdate): Promise<Reply> {
  const all = await deps.db.listEquipment(user.id);
  const exact = all.filter((item) => item.name.toLowerCase() === query.toLowerCase());
  const cards = exact.length === 1 ? exact : all.filter((item) => matches(item, query));
  if (cards.length === 0) return { text: `I don't have equipment matching "${query}". Nothing was changed.` };
  if (cards.length > 1) {
    const names = cards.map((item) => item.name).join(", ");
    return { text: `"${query}" matches ${cards.length} cards (${names}). Use the exact name. Nothing was changed.` };
  }
  const [current] = cards;
  if (!current) return { text: `I don't have equipment matching "${query}". Nothing was changed.` };
  const now = toIso(deps.clock.now());
  const saved = await deps.db.updateEquipment({
    ...current,
    vendor: changes.vendor ?? current.vendor,
    model: changes.model ?? current.model,
    firmwareVersion: changes.firmware ?? current.firmwareVersion,
    location: changes.location ?? current.location,
    ipAddress: changes.ip ?? current.ipAddress,
    notes: changes.notes ?? current.notes,
    updatedAt: now,
  });
  await deps.db.writeAudit({
    userId: user.id,
    action: "equipment.update",
    entity: "equipment",
    entityId: saved.id,
    metadata: { equipmentNumber: saved.equipmentNumber, fields: Object.keys(changes).join(",") },
    createdAt: now,
  }).catch((error: unknown) => {
    deps.logger.warn(
      { event: "audit_failed", message: error instanceof Error ? error.message : "audit failed" },
      "audit failed",
    );
  });
  return { text: `Updated equipment.\n\n${formatEquipmentCard(saved, await sourceLabel(deps, user, saved))}` };
}

function fromLabels(body: string, fallback: EquipmentKind): Draft | null {
  const fields = new Map<string, string>();
  for (const line of body.split(/\n/)) {
    const match = line.trim().match(LABEL);
    if (match?.[1] && match[2] != null) fields.set(labelKey(match[1]), match[2].trim());
  }
  if (!fields.has("name") && !fields.has("ip")) return null;
  const kind = kindFromWord(fields.get("type") ?? "") ?? fallback;
  return {
    name: clip(fields.get("name") ?? "", 200),
    kind,
    location: clip(fields.get("location") ?? "", 200),
    ip: fields.get("ip") ?? "",
    notes: clip(fields.get("notes") ?? "", 2000),
    vendor: clip(fields.get("vendor") ?? "", 100),
    model: clip(fields.get("model") ?? "", 100),
    firmware: clip(fields.get("firmware") ?? "", 100),
  };
}

function fromLines(lines: string[], fallback: EquipmentKind): Draft | null {
  if (lines.length < 3 || lines.some((line) => LABEL.test(line))) return null;
  const ip = lines.find((line) => isIp(line));
  if (!ip) return null;
  const rest = lines.filter((line) => line !== ip);
  const typeLine = rest.find((line) => kindFromWord(line));
  const details = rest.filter((line) => line !== typeLine);
  const name = details[0];
  if (!name) return null;
  return {
    name: clip(name, 200),
    kind: (typeLine ? kindFromWord(typeLine) : null) ?? fallback,
    location: clip(details[1] ?? "", 200),
    ip,
    notes: clip(details.slice(2).join(" "), 2000),
    vendor: "",
    model: "",
    firmware: "",
  };
}

function fromCommas(body: string, fallback: EquipmentKind): Draft | null {
  const parts = body.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const ip = parts.find((part) => isIp(part)) ?? "";
  const typePart = parts.find((part) => kindFromWord(part));
  const details = parts.filter((part) => part !== ip && part !== typePart);
  const name = details[0];
  if (!name) return null;
  return {
    name: clip(name, 200),
    kind: (typePart ? kindFromWord(typePart) : null) ?? fallback,
    location: clip(details[1] ?? "", 200),
    ip,
    notes: clip(details.slice(2).join(", "), 2000),
    vendor: "",
    model: "",
    firmware: "",
  };
}

async function saveDraft(
  deps: Deps,
  user: User,
  draft: Draft,
  sourceNoteId: string | null,
  sourceDocumentId: string | null,
): Promise<Reply> {
  const now = toIso(deps.clock.now());
  const existing = (await deps.db.listEquipment(user.id)).find((item) => item.name.toLowerCase() === draft.name.toLowerCase());
  const saved = existing
    ? await deps.db.updateEquipment({
        ...existing,
        kind: draft.kind,
        location: draft.location,
        ipAddress: draft.ip,
        notes: draft.notes || existing.notes,
        vendor: draft.vendor || existing.vendor,
        model: draft.model || existing.model,
        firmwareVersion: draft.firmware || existing.firmwareVersion,
        sourceNoteId: sourceNoteId ?? existing.sourceNoteId,
        sourceDocumentId: sourceDocumentId ?? existing.sourceDocumentId,
        updatedAt: now,
      })
    : await deps.db.insertEquipment({
        userId: user.id,
        name: draft.name,
        kind: draft.kind,
        location: draft.location,
        ipAddress: draft.ip,
        notes: draft.notes,
        vendor: draft.vendor,
        model: draft.model,
        firmwareVersion: draft.firmware,
        sourceNoteId,
        sourceDocumentId,
        createdAt: now,
      });
  await deps.db.writeAudit({
    userId: user.id,
    action: existing ? "equipment.update" : "equipment.create",
    entity: "equipment",
    entityId: saved.id,
    metadata: { equipmentNumber: saved.equipmentNumber },
    createdAt: now,
  }).catch((error: unknown) => {
    deps.logger.warn(
      { event: "audit_failed", message: error instanceof Error ? error.message : "audit failed" },
      "audit failed",
    );
  });
  const source = await sourceLabel(deps, user, saved);
  const verb = existing ? "Updated equipment." : "Saved equipment.";
  return { text: `${verb}\n\n${formatEquipmentCard(saved, source)}` };
}

async function listEquipment(deps: Deps, user: User, kind: EquipmentKind | "all"): Promise<Reply> {
  const cards = (await deps.db.listEquipment(user.id)).filter((item) => kind === "all" || item.kind === kind);
  if (cards.length === 0) {
    return { text: kind === "all" ? "You have no equipment yet." : `You have no ${PLURAL[kind].toLowerCase()}.` };
  }
  const heading = kind === "all" ? (cards.length === 1 ? "1 equipment card" : `${cards.length} equipment cards`) : PLURAL[kind];
  const rendered = await Promise.all(cards.map(async (item) => formatEquipmentCard(item, await sourceLabel(deps, user, item))));
  return { text: `${heading}\n\n${rendered.join("\n\n")}` };
}

async function showEquipment(deps: Deps, user: User, query: string): Promise<Reply> {
  const cards = (await deps.db.listEquipment(user.id)).filter((item) => matches(item, query));
  if (cards.length === 0) return { text: `I don't have equipment matching "${query}".` };
  const rendered = await Promise.all(cards.map(async (item) => formatEquipmentCard(item, await sourceLabel(deps, user, item))));
  const heading = cards.length === 1 ? "" : `I found ${cards.length} matches:\n\n`;
  return { text: `${heading}${rendered.join("\n\n")}` };
}

async function extractEquipment(
  deps: Deps,
  user: User,
  command: { source: "note" | "document"; number: number },
): Promise<Reply> {
  const loaded = await loadSource(deps, user, command);
  if (!loaded.ok) return { text: loaded.text };
  const llm = deps.llm;
  if (!llm) return { text: `I can save a card directly. Try: ${CREATE_EXAMPLE}` };
  const result = await llm.completeStructured({
    system: [
      "Extract equipment cards from the untrusted text.",
      "Include a device only when the text states its name and IP address.",
      "Do not invent names, locations, or IP addresses.",
      "type is printer, switch, access_point, or other.",
      "location and notes are empty strings when the text does not say them.",
      "vendor, model, and firmware are the manufacturer, model number, and firmware or OS version exactly as written. Use empty strings when the text does not state them. Never guess a version.",
    ].join(" "),
    user: wrapUntrusted(command.source, loaded.body),
    schemaName: "equipment_cards",
    schema: EQUIPMENT_JSON_SCHEMA,
  });
  await deps.db.recordUsage({
    userId: user.id,
    model: deps.env.XAI_MODEL,
    purpose: "equipment_extract",
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    estimatedUsd:
      (result.inputTokens / 1_000_000) * deps.env.XAI_INPUT_USD_PER_MILLION +
      (result.outputTokens / 1_000_000) * deps.env.XAI_OUTPUT_USD_PER_MILLION,
    createdAt: toIso(deps.clock.now()),
  }).catch(() => undefined);
  let parsed: z.infer<typeof ExtractedEquipmentSchema>;
  try {
    parsed = ExtractedEquipmentSchema.parse(JSON.parse(result.text));
  } catch {
    return { text: "I couldn't read equipment details from that. Send: " + CREATE_EXAMPLE };
  }
  const drafts = parsed.items
    .map((item) => ({
      name: item.name.trim(),
      kind: item.type,
      location: item.location.trim(),
      ip: item.ip.trim(),
      notes: item.notes.trim(),
      vendor: item.vendor.trim(),
      model: item.model.trim(),
      firmware: item.firmware.trim(),
    }))
    .filter((item) => item.name && isIp(item.ip) && !secretRisk(draftText(item)));
  if (drafts.length === 0) return { text: "I couldn't find a device with a stated IP address in that text." };
  const replies: string[] = [];
  for (const draft of drafts) {
    const saved = await saveDraft(deps, user, draft, loaded.noteId, loaded.documentId);
    replies.push(saved.text.replace(/^Saved equipment\.\n\n|^Updated equipment\.\n\n/, ""));
  }
  const label = drafts.length === 1 ? "Saved 1 equipment card." : `Saved ${drafts.length} equipment cards.`;
  return { text: `${label}\n\n${replies.join("\n\n")}` };
}

async function loadSource(
  deps: Deps,
  user: User,
  command: { source: "note" | "document"; number: number },
): Promise<{ ok: true; body: string; noteId: string | null; documentId: string | null } | { ok: false; text: string }> {
  if (command.source === "note") {
    const note = await deps.db.findNote(user.id, command.number);
    if (!note) return { ok: false, text: `I don't have note ${command.number}.` };
    return { ok: true, body: `${note.title}\n${note.content}`.slice(0, 24_000), noteId: note.id, documentId: null };
  }
  const document = await deps.db.findDocument(user.id, command.number);
  if (!document) return { ok: false, text: `I don't have document ${command.number}.` };
  const extraction = await deps.db.getExtraction(document.id);
  if (!extraction?.text.trim()) return { ok: false, text: `Document ${command.number} has no extracted text yet.` };
  return { ok: true, body: `${document.title}\n${extraction.text}`.slice(0, 24_000), noteId: null, documentId: document.id };
}

async function sourceLabel(deps: Deps, user: User, item: Equipment): Promise<string | null> {
  const parts: string[] = [];
  if (item.sourceNoteId) {
    const note = (await deps.db.listNotes(user.id)).find((entry) => entry.id === item.sourceNoteId);
    if (note) parts.push(`Note #${note.noteNumber}`);
  }
  if (item.sourceDocumentId) {
    const document = (await deps.db.listDocuments(user.id)).find((entry) => entry.id === item.sourceDocumentId);
    if (document) parts.push(`Document "${document.title}"`);
  }
  return parts.length > 0 ? parts.join(" / ") : null;
}

function matches(item: Equipment, query: string): boolean {
  const q = query.trim().toLowerCase().replace(/^the\s+/, "");
  if (item.ipAddress === q || item.name.toLowerCase() === q || item.name.toLowerCase().includes(q)) return true;
  const hint = kindFromText(q);
  const words = q.split(/\s+/).filter((word) => word && !["the", "a", "my", "ip", "address"].includes(word));
  const content = words.filter((word) => !kindFromWord(word) && word !== "access" && word !== "point" && word !== "points");
  if (hint && item.kind !== hint) return false;
  if (content.length === 0) return hint === item.kind;
  const haystack = `${item.name} ${item.location}`.toLowerCase();
  return content.every((word) => haystack.includes(word));
}

function listKind(value: string): EquipmentKind | "all" {
  const kind = kindFromWord(value);
  return kind ?? "all";
}

function inferKind(name: string, fallback: EquipmentKind): EquipmentKind {
  if (fallback !== "other") return fallback;
  if (/\b(?:printers?|laserjets?|laser\s*jets?)\b/i.test(name)) return "printer";
  return kindFromText(name) ?? fallback;
}

function kindFromText(value: string): EquipmentKind | null {
  if (/\bprinters?\b/i.test(value)) return "printer";
  if (/\bswitch(?:es)?\b/i.test(value)) return "switch";
  if (/\baccess points?\b|\baps?\b/i.test(value)) return "access_point";
  return null;
}

function kindFromWord(value: string): EquipmentKind | null {
  const word = value.trim().toLowerCase();
  if (/^(?:a\s+)?printers?$/.test(word)) return "printer";
  if (/^(?:a\s+)?switch(?:es)?$/.test(word)) return "switch";
  if (/^(?:an\s+)?access points?$|^access_point$|^aps?$/.test(word)) return "access_point";
  if (word === "other" || word === "other equipment") return "other";
  if (word === "equipment") return null;
  return null;
}

function isIp(value: string): boolean {
  return IPV4.test(value.trim());
}

function clip(value: string, max: number): string {
  return value.trim().slice(0, max);
}
