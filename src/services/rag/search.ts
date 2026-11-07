import type { Deps } from "../../app/deps.js";
import type { ChunkHit, ChunkMetadata, ChunkSource, SavedTextHit } from "../../database/types.js";
import { redactString } from "../../utils/text.js";
import { toIso } from "../../utils/time.js";
import { EMBEDDING_COLUMN_DIMENSIONS, ragConfig } from "./config.js";

const CANDIDATE_LIMIT = 16;
let warnedDimension = false;

export interface KnowledgeMatch {
  content: string;
  sourceType: ChunkSource;
  sourceId: string;
  sourceNumber: number;
  title: string;
  score: number;
  metadata: ChunkMetadata;
}

/** Embed the question, search chunks, and return ranked matches. An empty list means nothing useful was found. */
export async function hybridSearch(deps: Deps, userId: string, question: string, matchCount?: number): Promise<KnowledgeMatch[]> {
  const config = ragConfig(deps.env);
  const limit = clampCount(matchCount ?? config.topK);
  const trimmed = question.trim();
  if (!trimmed) return finish(deps, []);

  if (!warnedDimension && config.dimensions !== EMBEDDING_COLUMN_DIMENSIONS) {
    warnedDimension = true;
    deps.logger.warn(
      { event: "rag_dimension_mismatch", configured: config.dimensions, column: EMBEDDING_COLUMN_DIMENSIONS },
      "XAI_EMBEDDING_DIMENSIONS does not match the hybrid_search_chunks vector width",
    );
  }
  const embedding = await embedQuery(deps, trimmed, config.embeddingModel, EMBEDDING_COLUMN_DIMENSIONS);
  let hits: ChunkHit[] = [];
  try {
    hits = await deps.db.searchChunks(
      userId,
      trimmed,
      embedding.vector,
      embedding.ok ? config.embeddingModel : null,
      Math.min(CANDIDATE_LIMIT, limit + 4),
    );
    deps.logger.info(
      { event: "rag_hybrid_rpc", function: "hybrid_search_chunks", rows: hits.length },
      "hybrid_search_chunks returned",
    );
  } catch (error) {
    deps.logger.warn(
      { event: "rag_search_failed", message: redactString(error instanceof Error ? error.message : "search failed") },
      "chunk search failed",
    );
    const saved = await deps.db.searchSavedText(userId, trimmed).catch(() => []);
    hits = saved.filter((hit) => hit.similarity >= config.minScore).map(savedAsChunk);
  }
  if (hits.length === 0 && embedding.ok) {
    const saved = await deps.db.searchSavedText(userId, trimmed).catch(() => []);
    hits = saved.filter((hit) => hit.similarity >= config.minScore).map(savedAsChunk);
  }
  return finish(deps, prepareKnowledgeMatches(hits, limit, config.minScore));
}

export function prepareKnowledgeMatches(hits: ChunkHit[], matchCount: number, minScore: number): KnowledgeMatch[] {
  const ranked = hits
    .map(toMatch)
    .filter((hit) => hit.score >= minScore)
    .sort((left, right) => right.score - left.score || left.sourceType.localeCompare(right.sourceType) || left.sourceNumber - right.sourceNumber);
  const unique = dedupeKnowledgeMatches(ranked);
  return mixTypes(unique, clampCount(matchCount)).sort(
    (left, right) => right.score - left.score || left.sourceType.localeCompare(right.sourceType) || left.sourceNumber - right.sourceNumber,
  );
}

export function formatKnowledgeBlock(hit: KnowledgeMatch, index: number): string {
  return `[${index + 1}] ${sourceHeading(hit)} (${hit.metadata.chunk_type})\n${hit.content}`;
}

export function formatKnowledgeContext(results: KnowledgeMatch[]): string {
  return results.map((hit, index) => formatKnowledgeBlock(hit, index)).join("\n\n");
}

function finish(deps: Deps, results: KnowledgeMatch[]): KnowledgeMatch[] {
  deps.logger.info(
    { event: "rag_search", chunks: results.length, topScore: roundScore(results[0]?.score ?? 0) },
    "hybrid search",
  );
  return results;
}

function toMatch(hit: ChunkHit): KnowledgeMatch {
  return {
    content: hit.content,
    sourceType: hit.source,
    sourceId: hit.sourceId,
    sourceNumber: hit.sourceNumber,
    title: hit.title,
    score: hit.score,
    metadata: hit.metadata,
  };
}

export function dedupeKnowledgeMatches(ranked: KnowledgeMatch[]): KnowledgeMatch[] {
  const kept: KnowledgeMatch[] = [];
  for (const hit of ranked) {
    const index = kept.findIndex((existing) => sameSource(existing, hit) && nearDuplicate(existing.content, hit.content));
    if (index === -1) kept.push(hit);
    else if (hit.score > (kept[index]?.score ?? 0)) kept[index] = hit;
  }
  return kept;
}

function mixTypes(ranked: KnowledgeMatch[], limit: number): KnowledgeMatch[] {
  const picked = ranked.slice(0, limit);
  if (picked.length < 2) return picked;
  const first = picked[0];
  if (!first) return picked;
  const crowded = picked.every((hit) => hit.metadata.chunk_type === first.metadata.chunk_type);
  if (!crowded) return picked;
  const other = ranked.find((hit) => hit.metadata.chunk_type !== first.metadata.chunk_type);
  const lowest = picked[picked.length - 1];
  if (!other || !lowest || other.score + 0.05 < lowest.score) return picked;
  return [...picked.slice(0, -1), other];
}

function sameSource(left: KnowledgeMatch, right: KnowledgeMatch): boolean {
  if (left.sourceId && right.sourceId) return left.sourceType === right.sourceType && left.sourceId === right.sourceId;
  return left.sourceType === right.sourceType && left.sourceNumber === right.sourceNumber;
}

function nearDuplicate(left: string, right: string): boolean {
  const a = left.replace(/\s+/g, " ").trim();
  const b = right.replace(/\s+/g, " ").trim();
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length < 80) return false;
  return longer.includes(shorter) && shorter.length / longer.length >= 0.8;
}

function savedAsChunk(hit: SavedTextHit): ChunkHit {
  return {
    source: hit.source,
    sourceId: "",
    sourceNumber: hit.sourceNumber,
    title: hit.title,
    content: hit.excerpt,
    chunkType: "narrative",
    lexical: hit.similarity,
    vectorScore: 0,
    score: hit.similarity,
    metadata: { chunk_type: "narrative", embedding_model: null },
  };
}

export function sourceHeading(hit: KnowledgeMatch): string {
  if (hit.sourceType === "note") return `Note #${hit.sourceNumber}`;
  if (hit.sourceType === "knowledge") return `Knowledge: ${hit.title}`;
  if (/(^|\n)Key notes:/.test(hit.content)) return `Key notes: ${hit.title}`;
  return `Document: ${hit.title}`;
}

function clampCount(count: number): number {
  if (!Number.isFinite(count)) return 6;
  return Math.min(8, Math.max(1, Math.round(count)));
}

function roundScore(score: number): number {
  return Math.round(score * 1000) / 1000;
}

async function embedQuery(
  deps: Deps,
  question: string,
  model: string,
  dimensions: number,
): Promise<{ ok: boolean; vector: number[] | null }> {
  if (!deps.llm?.embed) return { ok: false, vector: null };
  try {
    const result = await deps.llm.embed({ texts: [`query: ${question}`], model, dimensions });
    const vector = result.vectors[0];
    if (!vector || vector.length !== dimensions) return { ok: false, vector: null };
    await deps.db.recordUsage({
      userId: null,
      model,
      purpose: "embedding",
      inputTokens: result.inputTokens,
      outputTokens: 0,
      estimatedUsd: 0,
      createdAt: toIso(deps.clock.now()),
    }).catch(() => undefined);
    return { ok: true, vector };
  } catch (error) {
    deps.logger.warn(
      { event: "rag_embedding_fallback", message: redactString(error instanceof Error ? error.message : "embedding failed") },
      "using trigram search without a query embedding",
    );
    return { ok: false, vector: null };
  }
}
