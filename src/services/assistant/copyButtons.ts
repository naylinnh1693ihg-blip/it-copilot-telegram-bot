import { secretRisk } from "../../utils/text.js";

/** A Telegram copy_text button. Telegram copies `text` (1-256 characters) to the clipboard. */
export interface CopyButton {
  label: string;
  text: string;
}

export const MAX_COPY_BUTTONS = 4;
const MAX_COPY_TEXT = 256;
const MAX_LABEL = 64;

const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\b/g;
const MAC = /\b[0-9A-F]{2}([-:])(?:[0-9A-F]{2}\1){4}[0-9A-F]{2}\b/gi;
const EXTENSION = /^\d{3,5}(?:[/\\]\d+)?$/;
/** "Alex — 6722" lines from a directory note. */
const NAME_DASH_EXTENSION = /^(.{1,80}?)\s+[-–—]\s+(\d{3,5}(?:[/\\]\d+)?)$/;

type Kind = "ip" | "extension" | "serial" | "mac" | "host";
const ORDER: Kind[] = ["ip", "extension", "serial", "mac", "host"];
const LABEL: Record<Kind, string> = { ip: "IP", extension: "ext", serial: "serial", mac: "MAC", host: "PC" };

/**
 * Header words that mean the value may be a credential. Such lines never get a button,
 * and nothing on them is scanned for IPs or MACs either.
 */
const SECRET_WORD = /^(?:password|passwd|passcode|passphrase|pass|pwd|key|apikey|token|secret|pin)$/;

/**
 * Field labels that start a new field when a card has been flattened onto one line
 * (RAG context does this). Credential labels are included so a secret field is split
 * off on its own and then skipped, instead of riding along with an IP before it.
 */
const FIELD_START = new RegExp(
  String.raw`\s+(?=(?:pc ?name|host ?name|computer(?: ?name)?|extension(?: ?(?:no|number|#))?|ext|ip ?address|scanner ?ip|ipv4|ip|serial(?: ?(?:number|no))?|mac(?: ?address)?|user(?: ?name)?|location|model|password|passwd|passcode|passphrase|pass|pwd|pin|token|secret|api ?key|key)\s*[:=])`,
  "gi",
);

function words(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function looksSecret(text: string): boolean {
  return words(text).some((word) => SECRET_WORD.test(word)) || secretRisk(text) !== null;
}

function headerKind(header: string): Kind | null {
  const key = header.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (/^(?:ip|ipaddress|scannerip|ipv4)$/.test(key)) return "ip";
  if (/^(?:extension|ext|extensionno|extensionnumber)$/.test(key)) return "extension";
  if (key.startsWith("serial")) return "serial";
  if (key === "mac" || key === "macaddress") return "mac";
  if (/^(?:pc|pcname|hostname|host|computer|computername)$/.test(key)) return "host";
  return null;
}

/**
 * Copy buttons for the identifiers in a lookup answer: "Header: value" cards from table
 * and directory notes, plus any IPv4 or MAC address written on a non-secret line.
 * Ordered IP, extension, serial, MAC, PC name; at most four; duplicates removed.
 */
export function copyButtonsFor(text: string, limit = MAX_COPY_BUTTONS): CopyButton[] {
  const found: Record<Kind, string[]> = { ip: [], extension: [], serial: [], mac: [], host: [] };
  for (const raw of text.split(/\n/).flatMap((line) => line.split(FIELD_START))) {
    const line = raw.replace(/^\s*(?:[•*-]\s+)?/, "").trim();
    if (!line || looksSecret(line)) continue;

    const labelled = line.match(/^([A-Za-z][A-Za-z0-9 #&/._-]{0,40}?)\s*[:=]\s*(.+)$/);
    const kind = labelled?.[1] ? headerKind(labelled[1]) : null;
    const value = labelled?.[2]?.trim() ?? "";
    if (kind && value) {
      if (kind === "ip") found.ip.push(...(value.match(IPV4) ?? []));
      else if (kind === "mac") found.mac.push(...(value.match(MAC) ?? []));
      else if (kind === "extension") {
        if (EXTENSION.test(value)) found.extension.push(value);
      } else if (!/\s/.test(value)) found[kind].push(value);
    }

    const dash = line.match(NAME_DASH_EXTENSION);
    if (dash?.[2]) found.extension.push(dash[2]);
    found.ip.push(...(line.match(IPV4) ?? []));
    found.mac.push(...(line.match(MAC) ?? []));
  }

  const buttons: CopyButton[] = [];
  const seen = new Set<string>();
  for (const kind of ORDER) {
    for (const value of found[kind]) {
      if (buttons.length >= limit) return buttons;
      if (!value || value.length > MAX_COPY_TEXT || seen.has(value)) continue;
      seen.add(value);
      buttons.push({ label: `Copy ${LABEL[kind]} ${value}`.slice(0, MAX_LABEL), text: value });
    }
  }
  return buttons;
}

/**
 * Buttons for a model-written answer. Candidates come from the retrieved context and are
 * kept only if the answer repeats them, so a button never copies something the model invented.
 */
export function groundedCopyButtons(answer: string, context: string): CopyButton[] {
  return copyButtonsFor(context, Number.POSITIVE_INFINITY)
    .filter((button) => containsToken(answer, button.text))
    .slice(0, MAX_COPY_BUTTONS);
}

function containsToken(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9.])${escaped}(?![A-Za-z0-9]|\\.\\d)`, "i").test(haystack);
}
