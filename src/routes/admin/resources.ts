import type express from "express";
import { z } from "zod";
import type { Deps } from "../../app/deps.js";
import {
  createKnowledge,
  deleteKnowledgeEntry,
  publicKnowledge,
  updateKnowledgeEntry,
} from "../../services/admin/knowledgeAdmin.js";
import { buildUsageSummary, formatUsd, type UsageRange } from "../../services/admin/usage.js";
import { MemoryService } from "../../services/memory/service.js";
import { MEMORY_TYPES, type MemoryType } from "../../types/models.js";
import { cleanText } from "../../utils/text.js";
import { toIso } from "../../utils/time.js";
import type { ActiveSession } from "../../services/admin/auth.js";
import type { Request, Response } from "express";

function activeSession(res: Response): ActiveSession {
  const active = res.locals.admin as ActiveSession | undefined;
  if (!active) throw new Error("Admin session missing.");
  return active;
}

type AsyncHandlerLike = (req: Request, res: Response) => Promise<void>;

const PositiveInt = z.coerce.number().int().positive();
const Tags = z.union([z.array(z.string()), z.string()]).optional();

const KnowledgeBody = z.object({
  title: z.string().max(200).optional(),
  content: z.string().min(1).max(8000),
  category: z.string().max(120).optional(),
  tags: Tags,
});

const KnowledgePatch = z.object({
  title: z.string().max(200).optional(),
  content: z.string().max(8000).optional(),
  category: z.string().max(120).optional(),
  tags: Tags,
});

const MemoryTypeSchema = z.enum(MEMORY_TYPES as unknown as [MemoryType, ...MemoryType[]]);

const MemoryCreate = z.object({
  content: z.string().min(1).max(2000),
  memoryType: MemoryTypeSchema.optional(),
  pinned: z.boolean().optional(),
  expiresAt: z.union([z.string().min(1), z.null()]).optional(),
});

const MemoryPatch = z.object({
  content: z.string().min(1).max(2000).optional(),
  memoryType: MemoryTypeSchema.optional(),
  pinned: z.boolean().optional(),
  expiresAt: z.union([z.string().min(1), z.null()]).optional(),
});

const UsageQuery = z.object({
  range: z.enum(["week", "month"]).default("month"),
});

export function registerAdminResourceRoutes(
  api: express.Router,
  deps: Deps,
  handle: (run: AsyncHandlerLike) => express.RequestHandler,
): void {
  api.get(
    "/overview",
    handle(async (_req, res) => {
      const { user } = activeSession(res);
      const now = deps.clock.now();
      const [knowledge, memories, usage] = await Promise.all([
        deps.db.listKnowledge(user.id),
        deps.db.listMemories(user.id, { limit: 500, nowIso: toIso(now), includeExpired: false }),
        buildUsageSummary(deps, user.id, "month"),
      ]);
      res.json({
        knowledgeCount: knowledge.length,
        memoryCount: memories.length,
        monthCostUsd: usage.totalUsd,
        monthCostLabel: formatUsd(usage.totalUsd),
      });
    }),
  );

  api.get(
    "/usage",
    handle(async (req, res) => {
      const { user } = activeSession(res);
      const query = UsageQuery.safeParse(req.query);
      if (!query.success) {
        res.status(400).json({ error: "Choose week or month for the usage range." });
        return;
      }
      const summary = await buildUsageSummary(deps, user.id, query.data.range as UsageRange);
      res.json(summary);
    }),
  );

  api.get(
    "/knowledge",
    handle(async (req, res) => {
      const { user } = activeSession(res);
      const q = typeof req.query.q === "string" ? cleanText(req.query.q, 200) : "";
      const entries = q ? await deps.db.searchKnowledge(user.id, q) : await deps.db.listKnowledge(user.id);
      res.json({ entries: entries.map(publicKnowledge) });
    }),
  );

  api.get(
    "/knowledge/:entryNumber",
    handle(async (req, res) => {
      const { user } = activeSession(res);
      const parsed = PositiveInt.safeParse(req.params.entryNumber);
      if (!parsed.success) {
        res.status(400).json({ error: "Entry number is not valid." });
        return;
      }
      const entry = await deps.db.findKnowledge(user.id, parsed.data);
      if (!entry) {
        res.status(404).json({ error: "That knowledge entry was not found." });
        return;
      }
      res.json({ entry: publicKnowledge(entry) });
    }),
  );

  api.post(
    "/knowledge",
    handle(async (req, res) => {
      const { user } = activeSession(res);
      const body = KnowledgeBody.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: "Check the title, content, and tags." });
        return;
      }
      const result = await createKnowledge(deps, user, body.data);
      if ("error" in result) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.status(201).json({ entry: publicKnowledge(result.entry) });
    }),
  );

  api.patch(
    "/knowledge/:entryNumber",
    handle(async (req, res) => {
      const { user } = activeSession(res);
      const parsed = PositiveInt.safeParse(req.params.entryNumber);
      if (!parsed.success) {
        res.status(400).json({ error: "Entry number is not valid." });
        return;
      }
      const body = KnowledgePatch.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: "Nothing to update." });
        return;
      }
      const result = await updateKnowledgeEntry(deps, user, parsed.data, body.data);
      if ("error" in result) {
        res.status(result.error.includes("not found") ? 404 : 400).json({ error: result.error });
        return;
      }
      res.json({ entry: publicKnowledge(result.entry) });
    }),
  );

  api.delete(
    "/knowledge/:entryNumber",
    handle(async (req, res) => {
      const { user } = activeSession(res);
      const parsed = PositiveInt.safeParse(req.params.entryNumber);
      if (!parsed.success) {
        res.status(400).json({ error: "Entry number is not valid." });
        return;
      }
      const result = await deleteKnowledgeEntry(deps, user, parsed.data);
      if ("error" in result) {
        res.status(404).json({ error: result.error });
        return;
      }
      res.json(result);
    }),
  );

  api.get(
    "/memories",
    handle(async (req, res) => {
      const { user } = activeSession(res);
      const q = typeof req.query.q === "string" ? cleanText(req.query.q, 200) : "";
      const type = typeof req.query.type === "string" && MEMORY_TYPES.includes(req.query.type as MemoryType) ? (req.query.type as MemoryType) : null;
      const includeExpired = req.query.includeExpired === "true";
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
      const nowIso = toIso(deps.clock.now());
      const memoryService = new MemoryService(deps);
      await memoryService.cleanup(user.id, nowIso);
      const memories = q
        ? await memoryService.searchMemories(user.id, q, limit)
        : await deps.db.listMemories(user.id, { limit, memoryType: type, includeExpired, nowIso });
      res.json({ memories: memories.map(publicMemory) });
    }),
  );

  api.get(
    "/memories/:memoryNumber",
    handle(async (req, res) => {
      const { user } = activeSession(res);
      const parsed = PositiveInt.safeParse(req.params.memoryNumber);
      if (!parsed.success) {
        res.status(400).json({ error: "Memory number is not valid." });
        return;
      }
      const memory = await deps.db.findMemory(user.id, parsed.data);
      if (!memory || memory.deletedAt) {
        res.status(404).json({ error: "That memory was not found." });
        return;
      }
      res.json({ memory: publicMemory(memory) });
    }),
  );

  api.post(
    "/memories",
    handle(async (req, res) => {
      const { user } = activeSession(res);
      const body = MemoryCreate.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: "Check the memory content and type." });
        return;
      }
      const memoryService = new MemoryService(deps);
      const saved = await memoryService.storeMemory(user.id, body.data.content, {
        memoryType: body.data.memoryType,
        pinned: body.data.pinned ?? false,
        expiresAt: body.data.expiresAt ?? null,
        sourceType: "admin",
        confidence: 1,
      });
      if ("error" in saved) {
        res.status(400).json({ error: saved.error });
        return;
      }
      const now = toIso(deps.clock.now());
      await deps.db.writeAudit({
        userId: user.id,
        action: "memory.create",
        entity: "memory",
        entityId: saved.memory.id,
        metadata: { memoryNumber: saved.memory.memoryNumber, source: "admin" },
        createdAt: now,
      });
      res.status(201).json({ memory: publicMemory(saved.memory), truncated: saved.truncated });
    }),
  );

  api.patch(
    "/memories/:memoryNumber",
    handle(async (req, res) => {
      const { user } = activeSession(res);
      const parsed = PositiveInt.safeParse(req.params.memoryNumber);
      if (!parsed.success) {
        res.status(400).json({ error: "Memory number is not valid." });
        return;
      }
      const body = MemoryPatch.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: "Nothing to update." });
        return;
      }
      const memoryService = new MemoryService(deps);
      const updated = await memoryService.updateMemory(user.id, parsed.data, body.data);
      if (!updated) {
        res.status(404).json({ error: "That memory was not found." });
        return;
      }
      if ("error" in updated) {
        res.status(400).json({ error: updated.error });
        return;
      }
      const now = toIso(deps.clock.now());
      await deps.db.writeAudit({
        userId: user.id,
        action: "memory.update",
        entity: "memory",
        entityId: updated.id,
        metadata: { memoryNumber: updated.memoryNumber },
        createdAt: now,
      });
      res.json({ memory: publicMemory(updated) });
    }),
  );

  api.delete(
    "/memories/:memoryNumber",
    handle(async (req, res) => {
      const { user } = activeSession(res);
      const parsed = PositiveInt.safeParse(req.params.memoryNumber);
      if (!parsed.success) {
        res.status(400).json({ error: "Memory number is not valid." });
        return;
      }
      const memoryService = new MemoryService(deps);
      const removed = await memoryService.deleteMemory(user.id, parsed.data);
      if (!removed) {
        res.status(404).json({ error: "That memory was not found." });
        return;
      }
      const now = toIso(deps.clock.now());
      await deps.db.writeAudit({
        userId: user.id,
        action: "memory.delete",
        entity: "memory",
        entityId: removed.id,
        metadata: { memoryNumber: removed.memoryNumber },
        createdAt: now,
      });
      res.json({ ok: true, memoryNumber: removed.memoryNumber });
    }),
  );
}

function publicMemory(memory: import("../../types/models.js").Memory) {
  return {
    memoryNumber: memory.memoryNumber,
    content: memory.content,
    memoryType: memory.memoryType,
    pinned: memory.pinned,
    sourceType: memory.sourceType,
    confidence: memory.confidence,
    expiresAt: memory.expiresAt,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  };
}
