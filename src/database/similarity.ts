/** Minimum pg_trgm word_similarity treated as a useful saved-text hit. Exact substrings score 1. */
export const SAVED_TEXT_MIN_SIMILARITY = 0.4;

const LEXICAL_STOP_WORDS = new Set([
  "a",
  "about",
  "an",
  "and",
  "are",
  "can",
  "could",
  "did",
  "do",
  "does",
  "for",
  "from",
  "how",
  "in",
  "is",
  "it",
  "me",
  "of",
  "on",
  "or",
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
  "with",
  "would",
]);

/** Keep technical terms and numeric identifiers; remove question filler. */
export function lexicalTerms(query: string): string[] {
  const tokens = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return [...new Set(tokens.filter((token) => (token.length > 1 || /^\d+$/.test(token)) && !LEXICAL_STOP_WORDS.has(token)))].slice(0, 12);
}

export function lexicalQuery(query: string): string {
  return lexicalTerms(query).join(" ") || query.trim().slice(0, 200);
}

/** Word coverage keeps a long natural-language question from diluting useful lexical matches. */
export function lexicalSimilarity(query: string, text: string): number {
  const normalizedQuery = query.trim().toLowerCase();
  const normalizedText = text.toLowerCase();
  if (!normalizedQuery || !normalizedText) return 0;
  if (normalizedText.includes(normalizedQuery)) return 1;
  const terms = lexicalTerms(query);
  if (terms.length === 0) return trigramWordSimilarity(normalizedQuery, normalizedText);
  const words = new Set(normalizedText.match(/[a-z0-9]+/g) ?? []);
  const total = terms.reduce(
    (score, term) => score + (words.has(term) ? 1 : term.length > 2 ? trigramWordSimilarity(term, normalizedText) : 0),
    0,
  );
  return total / terms.length;
}

function trigrams(value: string): Set<string> {
  const padded = `  ${value.toLowerCase()} `;
  const grams = new Set<string>();
  for (let index = 0; index <= padded.length - 3; index += 1) grams.add(padded.slice(index, index + 3));
  return grams;
}

/** Mirrors hybrid_search_chunks: lexical only until both vectors exist. */
export function hybridScore(lexical: number, vectorScore: number, hasVector: boolean): number {
  if (!hasVector) return lexical;
  return 0.45 * lexical + 0.55 * Math.max(0, vectorScore);
}

export function cosineSimilarity(left: number[], right: number[]): number {
  const width = Math.min(left.length, right.length);
  if (width === 0) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < width; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

/**
 * Approximation of Postgres `word_similarity(query, text)`: the share of the
 * query's trigrams found in the best-matching slice of `text`.
 */
export function trigramWordSimilarity(query: string, text: string): number {
  const needle = query.trim().toLowerCase();
  const haystack = text.toLowerCase();
  if (needle.length < 2 || haystack.length < 2) return 0;
  if (haystack.includes(needle)) return 1;
  const queryGrams = trigrams(needle);
  if (queryGrams.size === 0) return 0;
  const width = Math.min(haystack.length, Math.max(needle.length + 2, 4));
  const stride = haystack.length > 4_000 ? 3 : 1;
  let best = 0;
  for (let index = 0; index <= haystack.length - width; index += stride) {
    const sliceGrams = trigrams(haystack.slice(index, index + width));
    let shared = 0;
    for (const gram of queryGrams) if (sliceGrams.has(gram)) shared += 1;
    const score = shared / queryGrams.size;
    if (score > best) best = score;
    if (best >= 0.99) break;
  }
  return best;
}
