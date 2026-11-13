import { DateTime } from "luxon";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Deps } from "../src/app/deps.js";
import { createHttpApp } from "../src/routes/http.js";
import { issueLoginLink } from "../src/services/admin/auth.js";
import type { User } from "../src/types/models.js";
import { toIso } from "../src/utils/time.js";
import { NOW, ZONE, owner, testDeps } from "./helpers.js";

const SECRET = "a".repeat(64);

function adminDeps(overrides: Record<string, string> = {}) {
  const made = testDeps({ ADMIN_ENABLED: "true", ADMIN_SESSION_SECRET: SECRET, PUBLIC_BASE_URL: "https://copilot.test", ...overrides });
  let now = DateTime.fromISO(NOW, { zone: ZONE });
  made.deps.clock = { now: () => now };
  return made;
}

function tokenFrom(url: string): string {
  return new URL(url).hash.replace(/^#token=/, "");
}

async function signIn(deps: Deps, app: ReturnType<typeof createHttpApp>, user: User) {
  const link = await issueLoginLink(deps, user);
  if (!link.ok) throw new Error(link.message);
  const response = await request(app).post("/admin/api/auth/magic").send({ token: tokenFrom(link.url) });
  expect(response.status).toBe(200);
  const cookie = response.headers["set-cookie"]?.[0] ?? "";
  return { cookie: cookie.split(";")[0] ?? "", csrfToken: response.body.csrfToken as string };
}

describe("admin resource API", () => {
  it("manages knowledge, memories, and usage for the signed-in owner", async () => {
    const { deps, db } = adminDeps();
    const user = await owner(db);
    const app = createHttpApp(deps);
    const { cookie, csrfToken } = await signIn(deps, app, user);

    const created = await request(app)
      .post("/admin/api/knowledge")
      .set("Cookie", cookie)
      .set("X-CSRF-Token", csrfToken)
      .send({ title: "VPN", content: "Guest VLAN is 20.", category: "network", tags: "vlan" });
    expect(created.status).toBe(201);
    expect(created.body.entry.entryNumber).toBe(1);

    const listed = await request(app).get("/admin/api/knowledge").set("Cookie", cookie);
    expect(listed.status).toBe(200);
    expect(listed.body.entries).toHaveLength(1);

    const memory = await request(app)
      .post("/admin/api/memories")
      .set("Cookie", cookie)
      .set("X-CSRF-Token", csrfToken)
      .send({ content: "Prefer morning summaries.", pinned: true });
    expect(memory.status).toBe(201);
    expect(memory.body.memory.sourceType).toBe("admin");

    const pinned = await request(app)
      .patch("/admin/api/memories/1")
      .set("Cookie", cookie)
      .set("X-CSRF-Token", csrfToken)
      .send({ pinned: false });
    expect(pinned.status).toBe(200);
    expect(pinned.body.memory.pinned).toBe(false);

    await deps.db.recordUsage({
      userId: user.id,
      model: "grok-4.7",
      purpose: "test",
      inputTokens: 100,
      outputTokens: 50,
      estimatedUsd: 0,
      createdAt: toIso(deps.clock.now()),
    });

    const usage = await request(app).get("/admin/api/usage?range=month").set("Cookie", cookie);
    expect(usage.status).toBe(200);
    expect(usage.body.byModel.length).toBeGreaterThan(0);

    const overview = await request(app).get("/admin/api/overview").set("Cookie", cookie);
    expect(overview.status).toBe(200);
    expect(overview.body.knowledgeCount).toBe(1);
    expect(overview.body.memoryCount).toBe(1);

    const deleted = await request(app).delete("/admin/api/knowledge/1").set("Cookie", cookie).set("X-CSRF-Token", csrfToken);
    expect(deleted.status).toBe(200);

    const empty = await request(app).get("/admin/api/knowledge").set("Cookie", cookie);
    expect(empty.body.entries).toHaveLength(0);
  });

  it("rejects unauthenticated resource access", async () => {
    const { deps } = adminDeps();
    const app = createHttpApp(deps);
    expect((await request(app).get("/admin/api/knowledge")).status).toBe(401);
  });
});
