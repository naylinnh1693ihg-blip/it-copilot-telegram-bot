import type { Deps } from "../../app/deps.js";
import type { StoredChunk } from "../../database/types.js";
import { GrokError } from "../../utils/errors.js";
import { redactString, secretRisk } from "../../utils/text.js";
import { toIso } from "../../utils/time.js";
import { chunkText, type TextChunk } from "./chunk.js";
import { EMBEDDING_COLUMN_DIMENSIONS, ragConfig } from "./config.js";

const EMBED_BATCH = 8;
const EMBED_ATTEMPTS = 3;
/** Shorter than this is not a useful passage. "VLAN 20 is the guest network." still qualifies. */
const MIN_TEXT_CHARS = 12;

export type IngestStatus = "processed" | "skipped" | "failed";

export interface IngestCounts {
  processed: number;
  skipped: number;
  failed: number;
  narrative: number;
  identifier: number;
}

export async function indexSavedText(
  deps: Deps,
  input: {
    userId: string;
    source: StoredChunk["source"];
    sourceId: string;
    sourceNumber: number;
    title: string;
    text: string;
  },
): Promise<IngestStatus> {
  const result = await ingestSource(deps, input);
  logIngest(deps, input, result);
  return result.status;
}

/** Walk every saved note, knowledge entry, and document. One failure does not stop the run. */
export async function ingestKnowledge(deps: Deps): Promise<IngestCounts> {
  const counts: IngestCounts = { processed: 0, skipped: 0, failed: 0, narrative: 0, identifier: 0 };
  const userIds = await deps.db.listUserIds();
  for (const userId of userIds) {
    const notes = await deps.db.listNotes(userId);
    for (const note of notes) {
      await tally(counts, deps, {
        userId,
        source: "note",
        sourceId: note.id,
        sourceNumber: note.noteNumber,
        title: note.title,
        text: `${note.title}\n${note.content}`,
      });
    }
    const knowledge = await deps.db.listKnowledge(userId);
    for (const entry of knowledge) {
      await tally(counts, deps, {
        userId,
        source: "knowledge",
        sourceId: entry.id,
        sourceNumber: entry.entryNumber,
        title: entry.title,
        text: `${entry.title}\n${entry.content}`,
      });
    }
    const documents = await deps.db.listDocuments(userId);
    for (const document of documents) {
      const extraction = await deps.db.getExtraction(document.id);
      await tally(counts, deps, {
        userId,
        source: "document",
        sourceId: document.id,
        sourceNumber: document.documentNumber,
        title: document.title,
        text: `${document.title}\n${extraction?.text ?? ""}`,
      });
    }
  }
  deps.logger.info({ event: "rag_ingest_done", ...counts }, "knowledge ingest finished");
  return counts;
}

async function tally(
  counts: IngestCounts,
  deps: Deps,
  input: {
    userId: string;
    source: StoredChunk["source"];
    sourceId: string;
    sourceNumber: number;
    title: string;
    text: string;
  },
): Promise<void> {
  const result = await ingestSource(deps, input);
  counts[result.status] += 1;
  if (result.status !== "skipped") {
    counts.narrative += result.narrative;
    counts.identifier += result.identifier;
  }
  logIngest(deps, input, result);
}

function logIngest(
  deps: Deps,
  input: { source: StoredChunk["source"]; sourceId: string; sourceNumber: number },
  result: IngestResult,
): void {
  deps.logger.info(
    {
      event: "rag_ingest",
      source: input.source,
      sourceNumber: input.sourceNumber,
      status: result.status,
      narrative: result.narrative,
      identifier: result.identifier,
    },
    "knowledge ingest",
  );
  if (input.source !== "document") return;
  const chunks = result.status === "processed" ? result.narrative + result.identifier : 0;
  deps.logger.info(
    {
      event: "document_indexed",
      documentId: input.sourceId,
      documentNumber: input.sourceNumber,
      status: result.status,
      chunks,
    },
    `document indexed (${chunks} chunks)`,
  );
}

export async function ingestSource(
  deps: Deps,
  input: {
    userId: string;
    source: StoredChunk["source"];
    sourceId: string;
    sourceNumber: number;
    title: string;
    text: string;
  },
): Promise<IngestResult> {
  try {
    const cleaned = input.text.replace(/\s+/g, " ").trim();
    if (cleaned.length < MIN_TEXT_CHARS || secretRisk(input.text)) return { status: "skipped", narrative: 0, identifier: 0 };
    const config = ragConfig(deps.env);
    const equipment = await deps.db.listEquipment(input.userId).catch(() => []);
    const pieces = chunkText(input.text, {
      chunkTokens: config.chunkTokens,
      overlapTokens: config.overlapTokens,
      identifierNames: equipment.map((item) => item.name),
    });
    const narrative = pieces.filter((piece) => piece.chunkType === "narrative").length;
    const identifier = pieces.filter((piece) => piece.chunkType === "identifier").length;
    if (pieces.length === 0) return { status: "skipped", narrative: 0, identifier: 0 };
    const stored = await deps.db.listChunks(input.userId, input.source, input.sourceId);
    const canEmbed = !!deps.llm?.embed;
    if (isCurrent(stored, pieces, input.title, config.embeddingModel, canEmbed)) return { status: "skipped", narrative, identifier };
    const contents = pieces.map((piece) => piece.content);

    let embeddings: Array<number[] | null> = contents.map(() => null);
    let embedded = false;
    if (canEmbed) {
      embeddings = await embedPassages(deps, input.userId, contents, config.embeddingModel, EMBEDDING_COLUMN_DIMENSIONS);
      embedded = embeddings.every((vector) => vector !== null);
    }
    const chunks: StoredChunk[] = pieces.map((piece, chunkIndex) => ({
      source: input.source,
      sourceId: input.sourceId,
      sourceNumber: input.sourceNumber,
      title: input.title,
      chunkIndex,
      chunkType: piece.chunkType,
      content: piece.content,
      embedding: embeddings[chunkIndex] ?? null,
      embeddingModel: embeddings[chunkIndex] ? config.embeddingModel : null,
      metadata: { chunk_type: piece.chunkType, embedding_model: embeddings[chunkIndex] ? config.embeddingModel : null },
    }));
    await deps.db.replaceChunks(input.userId, input.source, input.sourceId, chunks);
    return { status: embedded || !canEmbed ? "processed" : "failed", narrative, identifier };
  } catch (error) {
    deps.logger.warn(
      {
        event: "rag_index_failed",
        source: input.source,
        sourceNumber: input.sourceNumber,
        message: redactString(error instanceof Error ? error.message : "index failed"),
      },
      "knowledge chunk was not indexed",
    );
    return { status: "failed", narrative: 0, identifier: 0 };
  }
}

interface IngestResult {
  status: IngestStatus;
  narrative: number;
  identifier: number;
}

function isCurrent(
  stored: StoredChunk[],
  pieces: TextChunk[],
  title: string,
  model: string,
  embedderAvailable: boolean,
): boolean {
  if (stored.length !== pieces.length) return false;
  const ordered = [...stored].sort((left, right) => left.chunkIndex - right.chunkIndex);
  return ordered.every((chunk, index) => {
    const piece = pieces[index];
    if (!piece || chunk.content !== piece.content || chunk.chunkType !== piece.chunkType || chunk.title !== title) return false;
    if (!embedderAvailable) return true;
    return chunk.embeddingModel === model;
  });
}

async function embedPassages(
  deps: Deps,
  userId: string,
  pieces: string[],
  model: string,
  dimensions: number,
): Promise<Array<number[] | null>> {
  const vectors: Array<number[] | null> = pieces.map(() => null);
  const embed = deps.llm?.embed;
  if (!embed) return vectors;
  let inputTokens = 0;
  for (let start = 0; start < pieces.length; start += EMBED_BATCH) {
    const batch = pieces.slice(start, start + EMBED_BATCH).map((piece) => `passage: ${piece}`);
    try {
      const result = await withRetry(() => embed({ texts: batch, model, dimensions }), deps.env.NODE_ENV === "test" ? 0 : 400);
      inputTokens += result.inputTokens;
      result.vectors.forEach((vector, index) => {
        vectors[start + index] = vector.length === dimensions ? vector : null;
      });
    } catch (error) {
      deps.logger.warn(
        { event: "rag_embedding_fallback", message: redactString(error instanceof Error ? error.message : "embedding failed") },
        "stored chunks without embeddings",
      );
      return vectors;
    }
  }
  await deps.db.recordUsage({
    userId,
    model,
    purpose: "embedding",
    inputTokens,
    outputTokens: 0,
    estimatedUsd: 0,
    createdAt: toIso(deps.clock.now()),
  }).catch(() => undefined);
  return vectors;
}

async function withRetry<T>(run: () => Promise<T>, delayMs: number): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= EMBED_ATTEMPTS; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      last = error;
      if (!isRetryable(error) || attempt === EMBED_ATTEMPTS) break;
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
  throw last;
}

function isRetryable(error: unknown): boolean {
  if (error instanceof GrokError) return error.retryable;
  if (!error || typeof error !== "object" || !("status" in error)) return true;
  const status = Number((error as { status: unknown }).status);
  return status === 0 || status === 408 || status === 429 || status >= 500;
}
