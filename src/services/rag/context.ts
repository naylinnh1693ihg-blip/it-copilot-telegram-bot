import type { AppLogger } from "../../utils/logger.js";
import { focusDirectoryRecord, focusTabularRecord } from "./table.js";
import { buildRagMessages } from "./prompt.js";
import { dedupeKnowledgeMatches, sourceHeading, type KnowledgeMatch } from "./search.js";

const CHARS_PER_TOKEN = 4;
const QUESTION_FILLER = new Set<string>([
  "a",
  "about",
  "and",
  "are",
  "can",
  "could",
  "did",
  "do",
  "does",
  "for",
  "how",
  "in",
  "is",
  "me",
  "of",
  "on",
  "should",
  "tell",
  "the",
  "to",
  "was",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "extension",
  "extensions",
  "ext",
  "user",
  "username",
  "number",
  "pc",
]);
const IDENTIFIER =
  /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\b|\b[a-z0-9]+(?:-[a-z0-9]+){1,8}\b|\b(?:HP|HPE|Cisco|Aruba|Ubiquiti|UniFi|Fortinet|FortiGate|Dell|LaserJet|Catalyst)\s+[A-Za-z0-9][A-Za-z0-9-]{1,24}\b|\b[A-Z]{1,6}\d{2,}[A-Z0-9-]*/gi;

export interface RagContext {
  /** False when nothing useful was available. Callers should use the non-RAG path. */
  relevant: boolean;
  context: string;
  blocks: string[];
  sources: string[];
  sourcesLine: string;
  chunks: number;
  tokens: number;
  included: KnowledgeMatch[];
}

export interface RagPrompt {
  relevant: boolean;
  system: string;
  user: string;
  context: RagContext;
}

/** Turn ranked chunks into a numbered context block that fits the token budget. */
export function buildRagContext(
  logger: AppLogger,
  results: KnowledgeMatch[],
  question: string,
  options?: { maxTokens?: number; minScore?: number },
): RagContext {
  const maxChars = Math.max(1, options?.maxTokens ?? 3000) * CHARS_PER_TOKEN;
  const minScore = options?.minScore ?? 0.4;
  const ranked = dedupeKnowledgeMatches(
    [...results]
      .filter((hit) => hit.score >= minScore && hit.content.trim().length > 0)
      .sort((left, right) => right.score - left.score || left.sourceNumber - right.sourceNumber),
  );
  const included: KnowledgeMatch[] = [];
  const blocks: string[] = [];
  let used = 0;
  for (const hit of ranked) {
    const focused = focusDelimitedFact(hit.content, question);
    const label = `[${blocks.length + 1}] ${sourceHeading(hit)} (${hit.metadata.chunk_type})`;
    const gap = blocks.length === 0 ? 0 : 2;
    const room = maxChars - used - gap - label.length - 1;
    if (room < 24) break;
    const body = fitChunk(focused, room);
    if (!body) continue;
    const block = `${label}\n${body}`;
    blocks.push(block);
    included.push(focused === hit.content ? hit : { ...hit, content: focused });
    used += gap + block.length;
  }
  const context = blocks.join("\n\n");
  const sources = uniqueSources(included);
  const built: RagContext = {
    relevant: blocks.length > 0 && question.trim().length > 0,
    context,
    blocks,
    sources,
    sourcesLine: citationLine(sources),
    chunks: blocks.length,
    tokens: Math.ceil(context.length / CHARS_PER_TOKEN),
    included,
  };
  logger.info({ event: "rag_context", chunks: built.chunks, tokens: built.tokens }, "built rag context");
  return built;
}

/** System and user text for a grounded answer. `relevant` is false when there is no context. */
export function buildRagPrompt(
  logger: AppLogger,
  results: KnowledgeMatch[],
  question: string,
  options?: { maxTokens?: number; minScore?: number },
): RagPrompt {
  const context = buildRagContext(logger, results, question, options);
  if (!context.relevant) return { relevant: false, system: "", user: "", context };
  const messages = buildRagMessages(question, context.context, { sourcesLine: context.sourcesLine });
  return { relevant: true, system: messages.system, user: messages.user, context };
}

function uniqueSources(hits: KnowledgeMatch[]): string[] {
  const labels: string[] = [];
  for (const hit of hits) {
    const label = sourceHeading(hit);
    if (!labels.includes(label)) labels.push(label);
  }
  return labels;
}

function citationLine(labels: string[]): string {
  const cited = labels.map(cite);
  if (cited.length === 0) return "";
  if (cited.length === 1) return `From ${cited[0]}`;
  if (cited.length === 2) return `From ${cited[0]} and ${cited[1]}`;
  return `From ${cited.slice(0, -1).join(", ")}, and ${cited[cited.length - 1]}`;
}

function cite(label: string): string {
  if (label.startsWith("Note #")) return `note #${label.slice("Note #".length)}`;
  if (label.startsWith("Document: ")) return `document ${label.slice("Document: ".length)}`;
  if (label.startsWith("Knowledge: ")) return `knowledge ${label.slice("Knowledge: ".length)}`;
  if (label.startsWith("Key notes: ")) return `key notes ${label.slice("Key notes: ".length)}`;
  return label;
}

export function focusDelimitedFact(content: string, question: string): string {
  const table = focusTabularRecord(content, question);
  const directory = focusDirectoryRecord(content, question);
  if (directory && (!table || isRecordList(table))) return directory;
  if (table) return table;

  const keywords = (question.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((word) => word.length > 2 && !QUESTION_FILLER.has(word));
  if (keywords.length === 0) return content;
  const lines = content.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 1) {
    const rankedLines = rankSegments(lines, keywords);
    const bestLine = rankedLines[0];
    const nextLine = rankedLines[1];
    if (bestLine && bestLine.matches > 0 && (!nextLine || bestLine.matches > nextLine.matches)) {
      return matchingExcerpt(bestLine.text, keywords[0] ?? "");
    }
  }
  const segments = content.split(/\s*\|\s*/).map((segment) => segment.trim()).filter(Boolean);
  if (segments.length < 2) return content;

  const ranked = rankSegments(segments, keywords);
  const best = ranked[0];
  const next = ranked[1];
  if (!best || best.matches === 0 || (next && best.matches === next.matches)) return content;
  return matchingExcerpt(best.text, keywords[0] ?? "");
}

function isRecordList(text: string): boolean {
  return /^(?:PCs|Printers|Records) in this note:/.test(text);
}

function rankSegments(segments: string[], keywords: string[]): Array<{ text: string; matches: number }> {
  return segments
    .map((text) => {
      const words = new Set<string>(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
      return { text, matches: keywords.filter((keyword) => words.has(keyword)).length };
    })
    .sort((left, right) => right.matches - left.matches);
}

function matchingExcerpt(text: string, keyword: string): string {
  const limit = 240;
  if (text.length <= limit || !keyword) return text;
  const index = text.toLowerCase().indexOf(keyword.toLowerCase());
  if (index < 0) return text;
  let start = Math.max(0, index - 60);
  let end = Math.min(text.length, index + keyword.length + 180);
  while (start > 0 && !/\s/.test(text[start - 1] ?? "")) start -= 1;
  while (end < text.length && !/\s/.test(text[end] ?? "")) end += 1;
  const excerpt = text.slice(start, end).trim();
  return `${start > 0 ? "… " : ""}${excerpt}${end < text.length ? " …" : ""}`;
}

function fitChunk(content: string, maxChars: number): string {
  const cleaned = content.replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  if (cleaned.length <= maxChars) return cleaned;
  const sentences = cleaned.split(/(?<=[.!?])\s+/).filter(Boolean);
  const important = sentences.filter((sentence) => identifiers(sentence).length > 0);
  const ordered = important.length > 0 ? important : sentences;
  let result = "";
  for (const sentence of ordered) {
    const next = result ? `${result} ${sentence}` : sentence;
    if (next.length <= maxChars) {
      result = next;
      continue;
    }
    if (!result) result = windowAroundIdentifiers(sentence, maxChars);
    break;
  }
  for (const id of identifiers(cleaned)) {
    if (result.includes(id) || result.length + 1 + id.length > maxChars) continue;
    result = `${result} ${id}`.trim();
  }
  if (result.length < cleaned.length) {
    result = result.length + 1 <= maxChars ? `${result}…` : `${result.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
  }
  return result.trim();
}

function windowAroundIdentifiers(sentence: string, maxChars: number): string {
  const focus = identifiers(sentence)[0];
  if (!focus || focus.length >= maxChars) return (focus ?? sentence).slice(0, maxChars).trim();
  const at = sentence.indexOf(focus);
  let start = Math.max(0, at - Math.floor((maxChars - focus.length) / 2));
  let end = Math.min(sentence.length, start + maxChars);
  const word = sentence.lastIndexOf(" ", start);
  if (word >= 0 && word < at) start = word + 1;
  if (end < sentence.length) {
    const space = sentence.lastIndexOf(" ", end);
    if (space > at + focus.length) end = space;
  }
  let slice = sentence.slice(start, end).trim();
  if (!slice.includes(focus)) slice = focus;
  return slice.length <= maxChars ? slice : focus;
}

function identifiers(text: string): string[] {
  return [...text.matchAll(IDENTIFIER)].map((match) => match[0]).filter((token) => /\d/.test(token) || /\s/.test(token));
}
