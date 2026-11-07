import type { Env } from "../../config/env.js";

/** Width of knowledge_chunks.embedding. Vectors of any other width are not stored. */
export const EMBEDDING_COLUMN_DIMENSIONS = 1024;

/** Retrieval settings. Chunk size stays inside 300–800 tokens. Top-K stays inside 4–8. */
export interface RagConfig {
  embeddingModel: string;
  dimensions: number;
  chunkTokens: number;
  overlapTokens: number;
  topK: number;
  /** Same bar as saved-text trigram search. Exact terms score 1. */
  minScore: number;
  contextTokens: number;
  lexicalWeight: number;
  vectorWeight: number;
}

export function ragConfig(env: Pick<Env, "XAI_EMBEDDING_MODEL" | "XAI_EMBEDDING_DIMENSIONS" | "RAG_CHUNK_TOKENS" | "RAG_CHUNK_OVERLAP_TOKENS" | "RAG_TOP_K" | "RAG_MIN_SCORE" | "RAG_CONTEXT_TOKENS">): RagConfig {
  return {
    embeddingModel: env.XAI_EMBEDDING_MODEL,
    dimensions: env.XAI_EMBEDDING_DIMENSIONS,
    chunkTokens: env.RAG_CHUNK_TOKENS,
    overlapTokens: env.RAG_CHUNK_OVERLAP_TOKENS,
    topK: env.RAG_TOP_K,
    minScore: env.RAG_MIN_SCORE,
    contextTokens: env.RAG_CONTEXT_TOKENS,
    lexicalWeight: 0.45,
    vectorWeight: 0.55,
  };
}
