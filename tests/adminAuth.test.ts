import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DateTime } from "luxon";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Deps } from "../src/app/deps.js";
import { parseEnv, missingRuntimeSettings } from "../src/config/env.js";
import { createHttpApp } from "../src/routes/http.js";
import { authenticate, issueLoginLink, redeemLoginToken } from "../src/services/admin/auth.js";
import type { User } from "../src/types/models.js";
import { NOW, ZONE, owner, testDeps } from "./helpers.js";

const SECRET = "a".repeat(64);

function adminDeps(overrides: Record<string, string> = {}) {
  const made = testDeps({ ADMIN_ENABLED: "true", ADMIN_SESSION_SECRET: SECRET, PUBLIC_BASE_URL: "https://copilot.test", ...overrides });
  let now = DateTime.fromISO(NOW, { zone: ZONE });
  made.deps.clock = { now: () => now };
  return {
    ...made,
    advance(duration: { minutes?: number; days?: number }) {
      now = now.plus(duration);
    },
  };
}

function tokenFrom(url: string): string {
  const token = new URL(url).hash.replace(/^#token=/, "");
  expect(token.length).toBeGreaterThan(20);
  return token;
}

async function otherUser(deps: Deps, telegramUserId: number): Promise<User> {
  return deps.db.upsertFromTelegram({ telegramUserId, displayName: "Other", timezone: ZONE, startedBot: true, at: NOW });
}

async function signIn(deps: Deps, app: ReturnType<typeof createHttpApp>, user: User) {
  const link = await issueLoginLink(deps, user);
  if (!link.ok) throw new Error(link.message);
  const response = await request(app).post("/admin/api/auth/magic").send({ token: tokenFrom(link.url) });
  expect(response.status).toBe(200);
  const cookie = response.headers["set-cookie"]?.[0] ?? "";
  return { cookie: cookie.split(";")[0] ?? "", csrfToken: response.body.csrfToken as string, setCookie: cookie };
}

describe("admin app switch", () => {
  it("returns 404 for /admin when ADMIN_ENABLED is not true", async () => {
    const { deps } = testDeps();
    expect(deps.env.ADMIN_ENABLED).toBe(false);
    const app = createHttpApp(deps);
    expect((await request(app).get("/admin")).status).toBe(404);
    expect((await request(app).get("/admin/api/auth/session")).status).toBe(404);
    expect((await request(app).post("/admin/api/auth/magic").send({ token: "x".repeat(40) })).status).toBe(404);
    expect((await request(app).get("/health")).status).toBe(200);
  });

  it("parses ADMIN_ENABLED strictly and requires a long secret when on", () => {
    expect(parseEnv({ ADMIN_ENABLED: "false" }).ADMIN_ENABLED).toBe(false);
    expect(parseEnv({ ADMIN_ENABLED: "yes" }).ADMIN_ENABLED).toBe(false);
    expect(parseEnv({ ADMIN_ENABLED: "TRUE" }).ADMIN_ENABLED).toBe(true);
    const short = parseEnv({ ADMIN_ENABLED: "true", ADMIN_SESSION_SECRET: "short" });
    expect(missingRuntimeSettings(short).join(" ")).toContain("ADMIN_SESSION_SECRET");
    const off = parseEnv({ ADMIN_ENABLED: "false" });
    expect(missingRuntimeSettings(off).join(" ")).not.toContain("ADMIN_SESSION_SECRET");
  });

  it("does not issue a link while the admin app is off", async () => {
    const { deps, db } = testDeps();
    const result = await issueLoginLink(deps, await owner(db));
    expect(result).toEqual({ ok: false, message: "The admin app is turned off." });
  });
});

describe("magic link sign-in", () => {
  it("signs the owner in once and promotes the configured owner to the owner role", async () => {
    const { deps, db } = adminDeps();
    const user = await owner(db);
    expect(user.role).toBe("user");
    const link = await issueLoginLink(deps, user);
    if (!link.ok) throw new Error(link.message);
    expect(link.url.startsWith("https://copilot.test/admin/login#token=")).toBe(true);
    expect((await db.findUserById(user.id))?.role).toBe("owner");

    const app = createHttpApp(deps);
    const token = tokenFrom(link.url);
    const first = await request(app).post("/admin/api/auth/magic").set("Host", "copilot.test").send({ token });
    expect(first.status).toBe(200);
    expect(first.body.user).toEqual({ displayName: "Nay", role: "owner" });
    const cookie = first.headers["set-cookie"]?.[0] ?? "";
    expect(cookie).toMatch(/^admin_session=/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/admin");

    const reused = await request(app).post("/admin/api/auth/magic").send({ token });
    expect(reused.status).toBe(401);
  });

  it("rejects an expired link", async () => {
    const { deps, db, advance } = adminDeps();
    const link = await issueLoginLink(deps, await owner(db));
    if (!link.ok) throw new Error(link.message);
    advance({ minutes: 10 });
    const app = createHttpApp(deps);
    const response = await request(app).post("/admin/api/auth/magic").send({ token: tokenFrom(link.url) });
    expect(response.status).toBe(401);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("rejects a forged or malformed token", async () => {
    const { deps, db } = adminDeps();
    await owner(db);
    const app = createHttpApp(deps);
    expect((await request(app).post("/admin/api/auth/magic").send({ token: "A".repeat(43) })).status).toBe(401);
    expect((await request(app).post("/admin/api/auth/magic").send({ token: "short" })).status).toBe(400);
    expect((await request(app).post("/admin/api/auth/magic").send({})).status).toBe(400);
  });

  it("refuses accounts without an admin role", async () => {
    const { deps, db } = adminDeps();
    const stranger = await otherUser(deps, 77);
    const result = await issueLoginLink(deps, stranger);
    expect(result.ok).toBe(false);
    expect((await db.findUserById(stranger.id))?.role).toBe("user");
  });

  it("stores only hashes of tokens and session ids", async () => {
    const { deps, db } = adminDeps();
    const user = await owner(db);
    const link = await issueLoginLink(deps, user);
    if (!link.ok) throw new Error(link.message);
    const token = tokenFrom(link.url);
    const created = await redeemLoginToken(deps, token, "test");
    if (!created) throw new Error("no session");
    const stored = JSON.stringify(db);
    expect(stored).not.toContain(token);
    expect(stored).not.toContain(created.sessionId);
  });

  it("rate-limits sign-in attempts", async () => {
    const { deps, db } = adminDeps();
    await owner(db);
    const app = createHttpApp(deps);
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      statuses.push((await request(app).post("/admin/api/auth/magic").send({ token: "B".repeat(43) })).status);
    }
    expect(statuses.slice(0, 10).every((status) => status === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("writes audit rows for link, login, and logout", async () => {
    const { deps, db } = adminDeps();
    const user = await owner(db);
    const app = createHttpApp(deps);
    const { cookie, csrfToken } = await signIn(deps, app, user);
    await request(app).post("/admin/api/auth/logout").set("Cookie", cookie).set("X-CSRF-Token", csrfToken).send({});
    const actions = (await db.listAudit(user.id, 10)).map((entry) => entry.action);
    expect(actions).toEqual(expect.arrayContaining(["admin_link_issued", "admin_login", "admin_logout"]));
  });
});

describe("admin sessions", () => {
  it("requires a session for API routes", async () => {
    const { deps, db } = adminDeps();
    await owner(db);
    const app = createHttpApp(deps);
    expect((await request(app).get("/admin/api/auth/session")).status).toBe(401);
    expect((await request(app).get("/admin/api/activity")).status).toBe(401);
    expect((await request(app).get("/admin/api/auth/session").set("Cookie", "admin_session=" + "C".repeat(43))).status).toBe(401);
  });

  it("returns the session and a CSRF token, and requires that token on writes", async () => {
    const { deps, db } = adminDeps();
    const user = await owner(db);
    const app = createHttpApp(deps);
    const { cookie, csrfToken } = await signIn(deps, app, user);

    const session = await request(app).get("/admin/api/auth/session").set("Cookie", cookie);
    expect(session.status).toBe(200);
    expect(session.body.csrfToken).toBe(csrfToken);
    expect(session.headers["cache-control"]).toBe("no-store");

    const missing = await request(app).post("/admin/api/auth/logout").set("Cookie", cookie).send({});
    expect(missing.status).toBe(403);
    const wrong = await request(app).post("/admin/api/auth/logout").set("Cookie", cookie).set("X-CSRF-Token", "x".repeat(64)).send({});
    expect(wrong.status).toBe(403);
    expect((await request(app).get("/admin/api/auth/session").set("Cookie", cookie)).status).toBe(200);

    const done = await request(app).post("/admin/api/auth/logout").set("Cookie", cookie).set("X-CSRF-Token", csrfToken).send({});
    expect(done.status).toBe(200);
    expect((await request(app).get("/admin/api/auth/session").set("Cookie", cookie)).status).toBe(401);
  });

  it("rejects writes from another origin and non-JSON writes", async () => {
    const { deps, db } = adminDeps();
    const user = await owner(db);
    const app = createHttpApp(deps);
    const { cookie, csrfToken } = await signIn(deps, app, user);
    const foreign = await request(app)
      .post("/admin/api/auth/logout")
      .set("Cookie", cookie)
      .set("X-CSRF-Token", csrfToken)
      .set("Origin", "https://evil.example")
      .send({});
    expect(foreign.status).toBe(403);
    const local = await request(app)
      .post("/admin/api/auth/logout")
      .set("Cookie", cookie)
      .set("X-CSRF-Token", csrfToken)
      .set("Host", "127.0.0.1:3000")
      .set("Origin", "http://127.0.0.1:3000")
      .send({});
    expect(local.status).toBe(200);
    const form = await request(app)
      .post("/admin/api/auth/logout")
      .set("Cookie", cookie)
      .set("X-CSRF-Token", csrfToken)
      .type("form")
      .send("a=1");
    expect(form.status).toBe(415);
  });

  it("expires after 7 idle days and slides forward while in use", async () => {
    const { deps, db, advance } = adminDeps();
    const user = await owner(db);
    const app = createHttpApp(deps);
    const { cookie } = await signIn(deps, app, user);
    advance({ days: 6 });
    expect((await request(app).get("/admin/api/auth/session").set("Cookie", cookie)).status).toBe(200);
    advance({ days: 6 });
    expect((await request(app).get("/admin/api/auth/session").set("Cookie", cookie)).status).toBe(200);
    advance({ days: 7 });
    expect((await request(app).get("/admin/api/auth/session").set("Cookie", cookie)).status).toBe(401);
  });

  it("stops working when the user loses the admin role", async () => {
    const { deps, db } = adminDeps();
    const admin = await otherUser(deps, 99);
    await db.setUserRole(admin.id, "admin");
    const app = createHttpApp(deps);
    const { cookie } = await signIn(deps, app, { ...admin, role: "admin" });
    expect((await request(app).get("/admin/api/auth/session").set("Cookie", cookie)).status).toBe(200);
    await db.setUserRole(admin.id, "user");
    expect((await request(app).get("/admin/api/auth/session").set("Cookie", cookie)).status).toBe(401);
  });

  it("shows each user only their own activity", async () => {
    const { deps, db } = adminDeps();
    const userA = await owner(db);
    const userB = await otherUser(deps, 99);
    await db.setUserRole(userB.id, "admin");
    await db.writeAudit({ userId: userB.id, action: "secret_b_action", entity: "note", entityId: null, metadata: {}, createdAt: NOW });
    const app = createHttpApp(deps);
    const a = await signIn(deps, app, userA);
    const activity = await request(app).get("/admin/api/activity?user_id=" + userB.id).set("Cookie", a.cookie);
    expect(activity.status).toBe(200);
    const actions = (activity.body.entries as Array<{ action: string }>).map((entry) => entry.action);
    expect(actions).toContain("admin_login");
    expect(actions).not.toContain("secret_b_action");
  });

  it("authenticate ignores revoked sessions", async () => {
    const { deps, db } = adminDeps();
    const user = await owner(db);
    const link = await issueLoginLink(deps, user);
    if (!link.ok) throw new Error(link.message);
    const created = await redeemLoginToken(deps, tokenFrom(link.url), null);
    if (!created) throw new Error("no session");
    expect(await authenticate(deps, created.sessionId)).not.toBeNull();
    await db.revokeAdminSession(created.session.id, user.id, NOW);
    expect(await authenticate(deps, created.sessionId)).toBeNull();
  });
});

describe("admin static shell", () => {
  it("serves the SPA with strict security headers and falls back to index.html", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "admin-static-"));
    writeFileSync(path.join(dir, "index.html"), "<!doctype html><div id=root></div>");
    const { deps } = adminDeps();
    const app = createHttpApp(deps, { adminStaticDir: dir });
    const page = await request(app).get("/admin/usage");
    expect(page.status).toBe(200);
    expect(page.text).toContain("id=root");
    expect(page.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(page.headers["x-frame-options"]).toBe("DENY");
    expect(page.headers["referrer-policy"]).toBe("same-origin");
  });

  it("explains when the frontend has not been built", async () => {
    const { deps } = adminDeps();
    const app = createHttpApp(deps, { adminStaticDir: path.join(tmpdir(), "missing-admin-build") });
    const page = await request(app).get("/admin");
    expect(page.status).toBe(503);
  });

  it("returns JSON 404 for unknown API routes after sign-in", async () => {
    const { deps, db } = adminDeps();
    const user = await owner(db);
    const app = createHttpApp(deps);
    const { cookie } = await signIn(deps, app, user);
    const response = await request(app).get("/admin/api/nope").set("Cookie", cookie);
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Not found." });
  });
});
