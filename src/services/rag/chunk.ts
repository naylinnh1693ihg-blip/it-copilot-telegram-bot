import { chunkInventory } from "./table.js";

const CHARS_PER_TOKEN = 4;
const IDENTIFIER_MIN_TOKENS = 50;
const IDENTIFIER_MAX_TOKENS = 150;
const IDENTIFIER_MIN_CHARS = IDENTIFIER_MIN_TOKENS * CHARS_PER_TOKEN;
const IDENTIFIER_MAX_CHARS = IDENTIFIER_MAX_TOKENS * CHARS_PER_TOKEN;

export type ChunkType = "narrative" | "identifier";

export interface TextChunk {
  content: string;
  chunkType: ChunkType;
}

export interface ChunkOptions {
  chunkTokens: number;
  overlapTokens: number;
  /** Known equipment names. A name of at least 4 characters is treated as an identifier. */
  identifierNames?: string[];
  includeIdentifierChunks?: boolean;
}

const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\b/g;
const FQDN = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:local|lan|internal|corp|com|net|org|io|lab)\b/gi;
const HOST = /\b[a-z][a-z0-9]*(?:-[a-z0-9]+){1,8}\b/gi;
const VLAN = /\bvlan\s*-?\s*\d{1,4}\b/gi;
const VENDOR_MODEL = /\b(?:HP|HPE|Cisco|Aruba|Ubiquiti|UniFi|Fortinet|FortiGate|Dell|Lenovo|Canon|Epson|Brother|Juniper|MikroTik|Catalyst|LaserJet|ThinkPad|PowerEdge)\s+[A-Za-z0-9][A-Za-z0-9-]{1,24}\b/g;
const PART_NUMBER = /\b(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z])[A-Z]{1,8}(?:-[A-Z0-9]+)+\b/g;
const MODEL_TOKEN = /\b(?=[A-Z0-9]*\d)[A-Z]{1,6}\d{2,}[A-Z0-9]*\b/g;

/** Split saved text into narrative passages plus short identifier passages. Tokens are characters / 4. */
export function chunkText(text: string, options: ChunkOptions): TextChunk[] {
  const size = Math.max(1, options.chunkTokens) * CHARS_PER_TOKEN;
  const overlap = Math.max(0, options.overlapTokens) * CHARS_PER_TOKEN;
  const cleaned = text.replace(/\r\n/g, "\n").trim();
  if (!cleaned) return [];
  const inventory = chunkInventory(cleaned, size);
  if (inventory) return inventory.map((content): TextChunk => ({ content, chunkType: "narrative" }));

  const narrative = (cleaned.length <= size ? [cleaned] : packNarrative(cleaned, size, overlap)).map(
    (content): TextChunk => ({ content, chunkType: "narrative" }),
  );
  const identifiers = options.includeIdentifierChunks === false
    ? []
    : identifierWindows(cleaned, options.identifierNames ?? [])
      .filter((content) => !coveredByShortNarrative(content, narrative))
      .map((content): TextChunk => ({ content, chunkType: "identifier" }));
  return [...narrative, ...identifiers];
}

function packNarrative(cleaned: string, size: number, overlap: number): string[] {
  const blocks: string[] = [];
  for (const paragraph of cleaned.split(/\n{2,}/)) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;
    if (trimmed.length <= size) {
      blocks.push(trimmed);
      continue;
    }
    for (const sentence of splitSentences(trimmed)) {
      if (sentence.length <= size) blocks.push(sentence);
      else {
        for (let index = 0; index < sentence.length; index += size) blocks.push(sentence.slice(index, index + size));
      }
    }
  }

  const packed: string[] = [];
  let current = "";
  for (const block of blocks) {
    const next = current ? `${current}\n\n${block}` : block;
    if (next.length <= size) current = next;
    else {
      if (current) packed.push(current);
      current = block;
    }
  }
  if (current) packed.push(current);
  return withOverlap(packed, overlap, size);
}

function splitSentences(paragraph: string): string[] {
  const parts = paragraph.split(/(?<=[.!?])\s+/);
  return parts.map((part) => part.trim()).filter(Boolean);
}

function withOverlap(chunks: string[], overlap: number, size: number): string[] {
  if (chunks.length < 2 || overlap === 0) return chunks;
  return chunks.map((chunk, index) => {
    if (index === 0) return chunk;
    const previous = chunks[index - 1] ?? "";
    const tail = previous.slice(Math.max(0, previous.length - overlap)).trim();
    if (!tail || chunk.startsWith(tail)) return chunk;
    const combined = `${tail}\n${chunk}`;
    return combined.length <= size + overlap ? combined : chunk;
  });
}

function identifierWindows(text: string, names: string[]): string[] {
  const spans = [...patternSpans(text), ...nameSpans(text, names)];
  const seen = new Set<string>();
  const windows: string[] = [];
  for (const span of spans) {
    const window = contextWindow(text, span.start, span.end);
    const key = normalize(window);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    windows.push(window);
  }
  return windows;
}

function patternSpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  for (const pattern of [IPV4, FQDN, VLAN, VENDOR_MODEL, PART_NUMBER, MODEL_TOKEN]) {
    for (const match of text.matchAll(pattern)) {
      if (match.index === undefined) continue;
      spans.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  for (const match of text.matchAll(HOST)) {
    if (match.index === undefined || !isHostname(match[0])) continue;
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return spans;
}

function isHostname(token: string): boolean {
  return token.length >= 4 && token.length <= 63 && token.includes("-") && /\d/.test(token);
}

function nameSpans(text: string, names: string[]): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  const unique = [...new Set(names.map((name) => name.trim()).filter((name) => name.length >= 4))];
  unique.sort((left, right) => right.length - left.length);
  for (const name of unique) {
    const pattern = new RegExp(escapeRegExp(name).replace(/\s+/g, "\\s+"), "gi");
    for (const match of text.matchAll(pattern)) {
      if (match.index === undefined) continue;
      spans.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  return spans;
}

function contextWindow(text: string, start: number, end: number): string {
  let left = sentenceStart(text, start);
  let right = sentenceEnd(text, end);
  while (right - left < IDENTIFIER_MIN_CHARS && (left > 0 || right < text.length)) {
    const nextLeft = left > 0 ? sentenceStart(text, left - 1) : left;
    const nextRight = right < text.length ? sentenceEnd(text, right + 1) : right;
    if (nextLeft === left && nextRight === right) break;
    if (nextRight - nextLeft > IDENTIFIER_MAX_CHARS && right - left > 0) break;
    left = nextLeft;
    right = nextRight;
  }
  if (right - left > IDENTIFIER_MAX_CHARS) {
    const center = Math.floor((start + end) / 2);
    left = Math.max(0, center - Math.floor(IDENTIFIER_MAX_CHARS / 2));
    right = Math.min(text.length, left + IDENTIFIER_MAX_CHARS);
    left = wordStart(text, left);
    right = wordEnd(text, right);
  }
  return text.slice(left, right).replace(/\s+/g, " ").trim();
}

function sentenceStart(text: string, index: number): number {
  let cursor = Math.max(0, index);
  while (cursor > 0 && !/[.!?]\s/.test(text.slice(cursor - 1, cursor + 1)) && text[cursor - 1] !== "\n") cursor -= 1;
  if (cursor > 0 && text[cursor - 1] !== "\n") cursor += 1;
  while (cursor < text.length && /\s/.test(text[cursor] ?? "")) cursor += 1;
  return cursor;
}

function sentenceEnd(text: string, index: number): number {
  let cursor = Math.min(text.length, index);
  while (cursor < text.length && text[cursor] !== "\n" && text[cursor] !== "." && text[cursor] !== "!" && text[cursor] !== "?") cursor += 1;
  if (cursor < text.length && text[cursor] !== "\n") cursor += 1;
  return cursor;
}

function wordStart(text: string, index: number): number {
  let cursor = index;
  while (cursor > 0 && !/\s/.test(text[cursor - 1] ?? "")) cursor -= 1;
  return cursor;
}

function wordEnd(text: string, index: number): number {
  let cursor = index;
  while (cursor < text.length && !/\s/.test(text[cursor] ?? "")) cursor += 1;
  return cursor;
}

function coveredByShortNarrative(window: string, narrative: TextChunk[]): boolean {
  const compact = normalize(window);
  return narrative.some((piece) => {
    if (piece.content.length > IDENTIFIER_MAX_CHARS) return false;
    const body = normalize(piece.content);
    return body === compact || body.includes(compact);
  });
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
