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
});
