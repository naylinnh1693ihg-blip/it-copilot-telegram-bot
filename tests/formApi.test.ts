import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Deps } from "../src/app/deps.js";
import { createHttpApp } from "../src/routes/http.js";
import { issueLoginLink } from "../src/services/admin/auth.js";
import type { User } from "../src/types/models.js";
import { NOW, ZONE, owner, testDeps } from "./helpers.js";

const SECRET = "a".repeat(64);

function adminApp() {
  const made = testDeps({ ADMIN_ENABLED: "true", ADMIN_SESSION_SECRET: SECRET, PUBLIC_BASE_URL: "https://copilot.test" });
  return { ...made, app: createHttpApp(made.deps) };
}

function tokenFrom(url: string): string {
  return new URL(url).hash.replace(/^#token=/, "");
}

async function signIn(deps: Deps, app: ReturnType<typeof createHttpApp>, user: User) {
  const link = await issueLoginLink(deps, user);
  if (!link.ok) throw new Error(link.message);
  const response = await request(app).post("/admin/api/auth/magic").send({ token: tokenFrom(link.url) });
  expect(response.status).toBe(200);
  const cookie = (response.headers["set-cookie"]?.[0] ?? "").split(";")[0] ?? "";
  return { cookie, csrfToken: response.body.csrfToken as string };
}

const contact = {
  full_name: "Ada Lovelace",
  email: "ada@example.com",
  phone: "",
  notes: "",
};

describe("form pages", () => {
  it("serves the admin page only after sign-in, and the Mini App without the admin frame policy", async () => {
    const { deps, app } = adminApp();
    const nay = await owner(deps.db);
    expect((await request(app).get("/admin/equipment")).status).toBe(302);
    const session = await signIn(deps, app, nay);
    const page = await request(app).get("/admin/equipment").set("Cookie", session.cookie);
    expect(page.status).toBe(200);
    expect(page.text).toContain('data-form="equipment"');
    expect(page.text).toContain("/forms/form.js");
    expect(page.headers["content-security-policy"]).toContain("script-src 'self'");

    const mini = await request(app).get("/miniapp/contact");
    expect(mini.status).toBe(200);
    expect(mini.text).toContain("https://telegram.org/js/telegram-web-app.js");
    expect(mini.text).toContain('data-form="contact"');
    expect(mini.headers["x-frame-options"]).toBeUndefined();
    expect((await request(app).get("/miniapp/nope")).status).toBe(404);
  });
});

describe("form records", () => {
  it("returns 401 when nobody is signed in", async () => {
    const { app } = adminApp();
    expect((await request(app).get("/admin/api/records/contact")).status).toBe(401);
    expect((await request(app).post("/admin/api/forms/contact").send(contact)).status).toBe(401);
    expect((await request(app).get("/api/records/contact")).status).toBe(401);
  });

  it("does not list or save another user's records", async () => {
    const { deps, app } = adminApp();
    const nay = await owner(deps.db);
    const other = await deps.db.upsertFromTelegram({
      telegramUserId: 99,
      displayName: "Other",
      timezone: ZONE,
      startedBot: true,
      at: NOW,
    });
    await deps.db.insertContact({
      userId: other.id,
      fullName: "Hidden Person",
      email: "hidden@example.com",
      phone: "",
      department: "",
      jobTitle: "",
      location: "",
      telegramUsername: "",
      notes: "",
      createdAt: NOW,
    });
    const session = await signIn(deps, app, nay);
    const listed = await request(app).get(`/admin/api/records/contact?user_id=${other.id}`).set("Cookie", session.cookie);
    expect(listed.status).toBe(200);
    expect(listed.body.records).toEqual([]);

    const saved = await request(app)
      .post("/admin/api/forms/contact")
      .set("Cookie", session.cookie)
      .set("X-CSRF-Token", session.csrfToken)
      .send({ ...contact, user_id: other.id });
    expect(saved.status).toBe(201);

    const mine = await request(app).get("/admin/api/records/contact").set("Cookie", session.cookie);
    expect(mine.body.records.map((row: { title: string }) => row.title)).toEqual(["Ada Lovelace"]);
    const theirs = await deps.db.listContacts(other.id);
    expect(theirs.map((row) => row.fullName)).toEqual(["Hidden Person"]);
    const audits = await deps.db.listAudit(nay.id, 10);
    expect(audits.some((entry) => entry.action === "contact.create")).toBe(true);
  });

  it("returns 422 when the email or the link is already saved", async () => {
    const { deps, app } = adminApp();
    const nay = await owner(deps.db);
    const session = await signIn(deps, app, nay);
    const first = await request(app)
      .post("/admin/api/forms/contact")
      .set("Cookie", session.cookie)
      .set("X-CSRF-Token", session.csrfToken)
      .send(contact);
    expect(first.status).toBe(201);
    const duplicate = await request(app)
      .post("/admin/api/forms/contact")
      .set("Cookie", session.cookie)
      .set("X-CSRF-Token", session.csrfToken)
      .send({ ...contact, full_name: "Ada Again", email: "Ada@Example.com" });
    expect(duplicate.status).toBe(422);
    expect(duplicate.body.errors.email).toMatch(/already exists/);

    const link = {
      title: "Firewall admin guide",
      url: "https://docs.vendor.com/firewall",
      category: "documentation",
      tags: "",
      description: "",
    };
    const saved = await request(app)
      .post("/admin/api/forms/link")
      .set("Cookie", session.cookie)
      .set("X-CSRF-Token", session.csrfToken)
      .send(link);
    expect(saved.status).toBe(201);
    const again = await request(app)
      .post("/admin/api/forms/link")
      .set("Cookie", session.cookie)
      .set("X-CSRF-Token", session.csrfToken)
      .send({ ...link, title: "Same guide", url: "https://docs.vendor.com/firewall?utm_source=x" });
    expect(again.status).toBe(422);
    expect(again.body.errors.url).toMatch(/already saved/);
  });
});
