import type { Deps } from "../../app/deps.js";
import type { MemoryQuery } from "../../database/types.js";
import type { Memory, MemoryType } from "../../types/models.js";
import { cleanText, secretRisk } from "../../utils/text.js";
import { toIso } from "../../utils/time.js";

/** Short facts only. Longer inventories stay in notes via "note this:". */
export const MEMORY_CONTENT_LIMIT = 2000;

export class MemoryService {
  constructor(private readonly deps: Deps) {}

  async storeMemory(
    userId: string,
    content: string,
    options?: { memoryType?: MemoryType; expiresAt?: string | null; metadata?: Record<string, string | number | boolean | null>; importance?: number | null },
  ): Promise<{ memory: Memory; truncated: boolean } | { error: string }> {
    const cleaned = cleanText(content, MEMORY_CONTENT_LIMIT + 1);
    const risk = secretRisk(cleaned);
    if (risk) return { error: `I didn't save that. It looks like a ${risk}. Keep passwords, keys, and tokens in a password manager, not in this copilot.` };
    if (!cleaned) return { error: "What should I remember?" };
    const truncated = cleaned.length > MEMORY_CONTENT_LIMIT;
    const body = truncated ? cleaned.slice(0, MEMORY_CONTENT_LIMIT).trimEnd() : cleaned;
    const now = toIso(this.deps.clock.now());
    const memory = await this.deps.db.insertMemory({
      userId,
      content: body,
      memoryType: options?.memoryType ?? inferMemoryType(body),
      importance: options?.importance ?? null,
      metadata: { ...(options?.metadata ?? {}), ...(truncated ? { truncated: true } : {}) },
      createdAt: now,
      expiresAt: options?.expiresAt ?? null,
    });
    this.deps.logger.info({ event: "memory_stored", memoryNumber: memory.memoryNumber, memoryType: memory.memoryType }, "memory stored");
    return { memory, truncated };
  }

  async retrieveMemories(userId: string, limit = 10, memoryType?: MemoryType | null, includeExpired = false): Promise<Memory[]> {
    const nowIso = toIso(this.deps.clock.now());
    await this.cleanup(userId, nowIso);
    const options: MemoryQuery = { limit, memoryType: memoryType ?? null, includeExpired, nowIso };
    const memories = await this.deps.db.listMemories(userId, options);
    this.deps.logger.info({ event: "memory_retrieved", count: memories.length }, "memories retrieved");
    return memories;
  }

  async searchMemories(userId: string, query: string, limit = 8): Promise<Memory[]> {
    const nowIso = toIso(this.deps.clock.now());
    await this.cleanup(userId, nowIso);
    const memories = await this.deps.db.searchMemories(userId, query, { limit, nowIso, includeExpired: false });
    this.deps.logger.info({ event: "memory_retrieved", count: memories.length }, "memories retrieved");
    return memories;
  }

  async updateMemory(
    userId: string,
    memoryNumber: number,
    patch: { content?: string; expiresAt?: string | null; metadata?: Record<string, string | number | boolean | null> },
  ): Promise<Memory | null> {
    const current = await this.deps.db.findMemory(userId, memoryNumber);
    if (!current) return null;
    const content = patch.content === undefined ? current.content : cleanText(patch.content, MEMORY_CONTENT_LIMIT);
    if (!content) return null;
    const risk = secretRisk(content);
    if (risk) return null;
    const updated = await this.deps.db.updateMemory({
      ...current,
      content,
      expiresAt: patch.expiresAt === undefined ? current.expiresAt : patch.expiresAt,
      metadata: patch.metadata ? { ...current.metadata, ...patch.metadata } : current.metadata,
      updatedAt: toIso(this.deps.clock.now()),
    });
    return updated;
  }

  async expireMemory(userId: string, memoryNumber: number): Promise<Memory | null> {
    const current = await this.deps.db.findMemory(userId, memoryNumber);
    if (!current) return null;
    const now = toIso(this.deps.clock.now());
    const expired = await this.deps.db.updateMemory({ ...current, expiresAt: now, deletedAt: now, updatedAt: now });
    this.deps.logger.info({ event: "memory_expired", memoryNumber }, "memory expired");
    return expired;
  }

  async deleteMemory(userId: string, memoryNumber: number): Promise<Memory | null> {
    return this.expireMemory(userId, memoryNumber);
  }

  async cleanup(userId: string, nowIso = toIso(this.deps.clock.now())): Promise<number> {
    const removed = await this.deps.db.deleteExpiredMemories(userId, nowIso);
    if (removed > 0) this.deps.logger.info({ event: "memory_expired", count: removed }, "expired memories cleaned up");
    return removed;
  }

  /** Relevant memories for a Grok or RAG answer. Empty when nothing matches. */
  async promptBlock(userId: string, question: string): Promise<{ text: string; numbers: number[] }> {
    const nowIso = toIso(this.deps.clock.now());
    await this.cleanup(userId, nowIso);
    const recent = await this.deps.db.listMemories(userId, { limit: 40, nowIso, includeExpired: false });
    const terms = (question.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((term) => term.length > 2 && !MEMORY_QUERY_FILLER.has(term));
    const ranked = recent
      .map((memory) => {
        const haystack = memory.content.toLowerCase();
        const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
        return { memory, score };
      })
      .filter((item) => terms.length === 0 || item.score > 0)
      .sort((left, right) => right.score - left.score || right.memory.memoryNumber - left.memory.memoryNumber)
      .slice(0, 8);
    if (ranked.length === 0) return { text: "", numbers: [] };
    this.deps.logger.info({ event: "memory_retrieved", count: ranked.length }, "memories retrieved");
    const lines = ranked.map((item) => `${item.memory.memoryNumber}. (${item.memory.memoryType}) ${item.memory.content}`);
    return { text: lines.join("\n"), numbers: ranked.map((item) => item.memory.memoryNumber) };
  }
}

const MEMORY_QUERY_FILLER = new Set(["the", "what", "whats", "how", "did", "does", "for", "about", "that", "this", "with"]);

export function inferMemoryType(content: string): MemoryType {
  if (/\bprefer(?:s|red|ence)?\b/i.test(content)) return "preference";
  if (/\b(?:printer|switch|access point|equipment|ip address)\b/i.test(content)) return "equipment";
  if (/\b(?:floor|site|office|building)\b/i.test(content)) return "context";
  return "fact";
}

export function formatMemoryList(memories: Memory[]): string {
  if (memories.length === 0) return "You have no saved memories.";
  const lines = memories.map((memory) => `${memory.memoryNumber}. ${memory.memoryType} — ${memory.content}`);
  return `Memories (${memories.length}):\n${lines.join("\n")}`;
}
