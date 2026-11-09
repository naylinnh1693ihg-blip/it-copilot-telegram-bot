import request from "supertest";
import { describe, expect, it } from "vitest";
import { createHttpApp } from "../src/routes/http.js";
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
});
