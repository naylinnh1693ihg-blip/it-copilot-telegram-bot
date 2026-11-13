import type { Deps } from "../../app/deps.js";
import type { KnowledgeEntry } from "../../types/models.js";
import type { User } from "../../types/models.js";
import { matchCategory } from "../knowledge/categories.js";
import { indexSavedText } from "../rag/ingest.js";
import { cleanText, parseTags, secretRisk } from "../../utils/text.js";
import { toIso } from "../../utils/time.js";

const CONTENT_LIMIT = 8000;
const TITLE_LIMIT = 80;

export type KnowledgeInput = {
  title?: string;
  content?: string;
  category?: string;
  tags?: string[] | string;
};

function normalizeTags(tags: string[] | string | undefined): string[] {
  if (Array.isArray(tags)) return tags.map((tag) => cleanText(tag, 40)).filter(Boolean);
  if (typeof tags === "string") return parseTags(tags);
  return [];
}

function validateBody(content: string): { ok: true; content: string } | { ok: false; error: string } {
  const cleaned = cleanText(content, CONTENT_LIMIT);
  if (!cleaned) return { ok: false, error: "Content is required." };
  const risk = secretRisk(cleaned);
  if (risk) {
    return {
      ok: false,
      error: `I didn't save that. It looks like a ${risk}. Keep passwords, keys, and tokens in a password manager, not in this copilot.`,
    };
  }
  return { ok: true, content: cleaned };
}

export async function createKnowledge(deps: Deps, user: User, input: KnowledgeInput): Promise<{ entry: KnowledgeEntry } | { error: string }> {
  const validated = validateBody(input.content ?? "");
  if (!validated.ok) return { error: validated.error };
  const title = cleanText(input.title || validated.content, TITLE_LIMIT) || "Untitled";
  const category = input.category ? matchCategory(input.category) : matchCategory(validated.content);
  const now = toIso(deps.clock.now());
  const entry = await deps.db.insertKnowledge({
    userId: user.id,
    title,
    content: validated.content,
    category,
    tags: normalizeTags(input.tags),
    createdAt: now,
  });
  await deps.db.writeAudit({
    userId: user.id,
    action: "knowledge.create",
    entity: "knowledge",
    entityId: entry.id,
    metadata: { entryNumber: entry.entryNumber },
    createdAt: now,
  });
  await indexSavedText(deps, {
    userId: user.id,
    source: "knowledge",
    sourceId: entry.id,
    sourceNumber: entry.entryNumber,
    title: entry.title,
    text: `${entry.title}\n${entry.content}`,
  });
  return { entry };
}

export async function updateKnowledgeEntry(
  deps: Deps,
  user: User,
  entryNumber: number,
  input: KnowledgeInput,
): Promise<{ entry: KnowledgeEntry } | { error: string }> {
  const current = await deps.db.findKnowledge(user.id, entryNumber);
  if (!current || current.deletedAt) return { error: "That knowledge entry was not found." };
  let content = current.content;
  if (input.content !== undefined) {
    const validated = validateBody(input.content);
    if (!validated.ok) return { error: validated.error };
    content = validated.content;
  }
  const title =
    input.title === undefined ? current.title : cleanText(input.title, TITLE_LIMIT) || current.title;
  const category =
    input.category === undefined
      ? current.category
      : input.category
        ? matchCategory(input.category)
        : matchCategory(content);
  const tags = input.tags === undefined ? current.tags : normalizeTags(input.tags);
  const now = toIso(deps.clock.now());
  const entry = await deps.db.updateKnowledge({
    ...current,
    title,
    content,
    category,
    tags,
    updatedAt: now,
  });
  await deps.db.writeAudit({
    userId: user.id,
    action: "knowledge.update",
    entity: "knowledge",
    entityId: entry.id,
    metadata: { entryNumber: entry.entryNumber },
    createdAt: now,
  });
  await indexSavedText(deps, {
    userId: user.id,
    source: "knowledge",
    sourceId: entry.id,
    sourceNumber: entry.entryNumber,
    title: entry.title,
    text: `${entry.title}\n${entry.content}`,
  });
  return { entry };
}

export async function deleteKnowledgeEntry(
  deps: Deps,
  user: User,
  entryNumber: number,
): Promise<{ ok: true; entryNumber: number } | { error: string }> {
  const current = await deps.db.findKnowledge(user.id, entryNumber);
  if (!current || current.deletedAt) return { error: "That knowledge entry was not found." };
  const now = toIso(deps.clock.now());
  await deps.db.updateKnowledge({ ...current, deletedAt: now, updatedAt: now });
  await deps.db.replaceChunks(user.id, "knowledge", current.id, []);
  await deps.db.writeAudit({
    userId: user.id,
    action: "knowledge.delete",
    entity: "knowledge",
    entityId: current.id,
    metadata: { entryNumber },
    createdAt: now,
  });
  return { ok: true, entryNumber };
}

export function publicKnowledge(entry: KnowledgeEntry) {
  return {
    entryNumber: entry.entryNumber,
    title: entry.title,
    content: entry.content,
    category: entry.category,
    tags: entry.tags,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}
