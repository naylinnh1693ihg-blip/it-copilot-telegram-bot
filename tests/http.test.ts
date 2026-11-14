import { readFileSync } from "node:fs";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createHttpApp, REMINDER_TRIGGER_LIMIT_PER_MINUTE } from "../src/routes/http.js";
import { NOW, owner, testDeps } from "./helpers.js";

describe("http routes", () => {
  it("serves health and protects the reminder endpoint and webhook", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    await db.insertReminder({
      userId: user.id,
      title: "Backup",
      message: "Check the backup",
      kind: "once",
      timezone: "Asia/Dubai",
      nextRunAt: "2026-10-30T06:00:00.000Z",
      weekdays: [],
      intervalMinutes: null,
      status: "active",
      dedupeKey: "http-backup",
      createdAt: NOW,
    });
    let sent = 0;
    const app = createHttpApp(deps, {
      sendTelegram: async () => {
        sent += 1;
        return { messageId: 3 };
      },
      webhook: (_req, res) => {
        res.status(200).json({ forwarded: true });
      },
    });

    const health = await request(app).get("/health");
    expect(health.status).toBe(200);
    expect(health.body.service).toBe("it-work-copilot");

    const denied = await request(app).post("/internal/reminders/process").send({});
    expect(denied.status).toBe(401);
    expect(sent).toBe(0);

    const accepted = await request(app).post("/internal/reminders/process").set("Authorization", "Bearer cron_secret_value").send({});
    expect(accepted.status).toBe(200);
    expect(accepted.body.sent).toBe(1);
    expect(sent).toBe(1);

    const webhook = await request(app).post("/telegram/webhook").send({ update_id: 1 });
    expect(webhook.status).toBe(401);
    const allowed = await request(app).post("/telegram/webhook").set("X-Telegram-Bot-Api-Secret-Token", "hook_secret").send({ update_id: 1 });
    expect(allowed.status).toBe(200);
    expect(allowed.body.forwarded).toBe(true);
  });

  it("checks webhook secrets before rate limiting and keys limits by the trusted proxy IP", async () => {
    const { deps } = testDeps();
    const app = createHttpApp(deps, {
      webhook: (_req, res) => {
        res.status(200).json({ forwarded: true });
      },
    });

    for (let attempt = 0; attempt < 120; attempt += 1) {
      const denied = await request(app)
        .post("/telegram/webhook")
        .set("X-Forwarded-For", "198.51.100.10")
        .send({ update_id: attempt });
      expect(denied.status).toBe(401);
    }

    const accepted = await request(app)
      .post("/telegram/webhook")
      .set("X-Forwarded-For", "198.51.100.10")
      .set("X-Telegram-Bot-Api-Secret-Token", "hook_secret")
      .send({ update_id: 121 });
    expect(accepted.status).toBe(200);

    for (let attempt = 0; attempt < 119; attempt += 1) {
      const allowed = await request(app)
        .post("/telegram/webhook")
        .set("X-Forwarded-For", "198.51.100.10")
        .set("X-Telegram-Bot-Api-Secret-Token", "hook_secret")
        .send({ update_id: attempt });
      expect(allowed.status).toBe(200);
    }

    const limited = await request(app)
      .post("/telegram/webhook")
      .set("X-Forwarded-For", "198.51.100.10")
      .set("X-Telegram-Bot-Api-Secret-Token", "hook_secret")
      .send({ update_id: 120 });
    expect(limited.status).toBe(429);

    const separateIp = await request(app)
      .post("/telegram/webhook")
      .set("X-Forwarded-For", "198.51.100.11")
      .set("X-Telegram-Bot-Api-Secret-Token", "hook_secret")
      .send({ update_id: 122 });
    expect(separateIp.status).toBe(200);
  });

  it("exposes request, error, latency, and runtime metrics for local monitoring", async () => {
    const { deps } = testDeps();
    deps.db.ping = async () => ({ ok: false, reason: "test failure" });
    const app = createHttpApp(deps);

    await request(app).get("/health");
    await request(app).get("/health/ready");
    const response = await request(app).get("/metrics");

    expect(response.status).toBe(200);
    expect(response.text).toContain('it_work_http_requests_total{method="GET",route="/health",status="200"} 1');
    expect(response.text).toContain('it_work_http_errors_total{method="GET",route="/health/ready",status="503"} 1');
    expect(response.text).toContain("it_work_http_request_duration_seconds_bucket");
    expect(response.text).toContain("it_work_process_cpu");
  });
});

describe("reminder trigger for Supabase cron", () => {
  const SECRET = "Bearer cron_secret_value";

  async function setup() {
    const { deps, db } = testDeps();
    const events: Array<Record<string, unknown>> = [];
    deps.logger = { info(obj) { events.push(obj); }, warn() {}, error() {}, debug() {} };
    const user = await owner(db);
    await db.insertReminder({
      userId: user.id,
      title: "Backup",
      message: "Check the secret backup vault",
      kind: "once",
      timezone: "Asia/Dubai",
      nextRunAt: "2026-10-30T06:00:00.000Z",
      weekdays: [],
      intervalMinutes: null,
      status: "active",
      dedupeKey: "cron-backup",
      createdAt: NOW,
    });
    const claim = vi.spyOn(deps.db, "claimDueReminders");
    const app = createHttpApp(deps, {
      sendTelegram: async () => ({ messageId: 9 }),
      webhook: (_req, res) => {
        res.status(200).json({ forwarded: true });
      },
    });
    return { app, claim, events };
  }

  it("runs the processor once for the right secret and returns only counts", async () => {
    const { app, claim, events } = await setup();
    const response = await request(app).post("/internal/reminders/process").set("Authorization", SECRET).send({});
    expect(response.status).toBe(200);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(response.body).toEqual({ ok: true, sent: 1, failed: 0, skipped: 0 });
    expect(Object.entries(response.body).every(([key, value]) => key === "ok" || typeof value === "number")).toBe(true);
    expect(response.text).not.toContain("secret backup vault");
    expect(response.text).not.toContain("cron_secret_value");
    expect(events).toContainEqual({ event: "reminder_cron_run", source: "http", sent: 1, failed: 0, skipped: 0 });
  });

  it("rejects a missing or wrong secret without running the processor", async () => {
    const { app, claim } = await setup();
    for (const header of [undefined, "Bearer wrong", "cron_secret_value_but_longer", "Basic cron_secret_value"]) {
      const call = request(app).post("/internal/reminders/process");
      const response = await (header ? call.set("Authorization", header) : call).send({});
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ ok: false });
    }
    expect(claim).not.toHaveBeenCalled();
  });

  it("is not rate limited at 70 calls a minute, even after heavy webhook traffic", async () => {
    const { app, claim } = await setup();
    for (let index = 0; index < 150; index += 1) {
      await request(app).post("/telegram/webhook").set("X-Telegram-Bot-Api-Secret-Token", "hook_secret").send({ update_id: index });
    }
    for (let index = 0; index < 70; index += 1) {
      const response = await request(app).post("/internal/reminders/process").set("Authorization", SECRET).send({});
      expect(response.status).toBe(200);
    }
    expect(claim).toHaveBeenCalledTimes(70);
  });

  it(`limits one caller to ${REMINDER_TRIGGER_LIMIT_PER_MINUTE} authenticated calls a minute`, async () => {
    const { app } = await setup();
    for (let index = 0; index < REMINDER_TRIGGER_LIMIT_PER_MINUTE; index += 1) {
      await request(app).post("/internal/reminders/process").set("Authorization", SECRET).send({});
    }
    const over = await request(app).post("/internal/reminders/process").set("Authorization", SECRET).send({});
    expect(over.status).toBe(429);
  });

  it("keeps secrets out of the cron migration and render.yaml", () => {
    const migration = readFileSync(new URL("../supabase/migrations/20261115010000_reminder_cron.sql", import.meta.url), "utf8");
    expect(migration).toContain("vault.decrypted_secrets");
    expect(migration).not.toMatch(/Bearer [A-Za-z0-9_-]{8,}/);
    expect(migration).not.toMatch(/https:\/\/[a-z0-9.-]+\.(?:onrender\.com|example\.com)/);
    expect(migration).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}|sb_secret_/);
    const blueprint = readFileSync(new URL("../render.yaml", import.meta.url), "utf8");
    expect(blueprint).toMatch(/- key: CRON_SECRET\n\s+sync: false/);
  });
});

