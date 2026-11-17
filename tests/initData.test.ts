import { createHmac } from "node:crypto";
import { DateTime } from "luxon";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createHttpApp } from "../src/routes/http.js";
import { NOW, ZONE, testDeps } from "./helpers.js";

const TOKEN = "123456:test-token-value";

function nowSeconds(): number {
  return Math.floor(DateTime.fromISO(NOW, { zone: ZONE }).toSeconds());
}

function signInitData(fields: Record<string, string>, token = TOKEN): string {
  const dataCheck = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(dataCheck).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

function initData(userId: number, authDate = nowSeconds()): string {
  return signInitData({
    auth_date: String(authDate),
    query_id: "AAE",
    user: JSON.stringify({ id: userId, first_name: "Nay" }),
  });
}

const equipment = {
  name: "Dell Latitude 5440",
  kind: "laptop",
  location: "Floor 2",
  ip_address: "",
  notes: "",
};

describe("Mini App initData", () => {
  it("accepts a fresh owner session", async () => {
    const sent: string[] = [];
    const { deps } = testDeps();
    const app = createHttpApp(deps, { sendTelegram: async (_chatId, text) => { sent.push(text); return { messageId: 1 }; } });
    const response = await request(app).post("/api/forms/equipment").set("X-Telegram-Init-Data", initData(42)).send(equipment);
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ number: 1, summary: "Dell Latitude 5440" });
    expect(sent).toEqual(["Saved equipment #1: Dell Latitude 5440."]);
  });

  it("rejects a tampered hash", async () => {
    const { deps } = testDeps();
    const app = createHttpApp(deps);
    const header = initData(42).replace(/hash=([0-9a-f])/, (_match, digit: string) => `hash=${digit === "a" ? "b" : "a"}`);
    const response = await request(app).post("/api/forms/equipment").set("X-Telegram-Init-Data", header).send(equipment);
    expect(response.status).toBe(401);
  });

  it("rejects an expired auth_date", async () => {
    const { deps } = testDeps();
    const app = createHttpApp(deps);
    const response = await request(app)
      .post("/api/forms/equipment")
      .set("X-Telegram-Init-Data", initData(42, nowSeconds() - 60 * 60 - 1))
      .send(equipment);
    expect(response.status).toBe(401);
  });

  it("rejects a user who is not the owner", async () => {
    const { deps } = testDeps();
    const app = createHttpApp(deps);
    const response = await request(app).post("/api/forms/equipment").set("X-Telegram-Init-Data", initData(99)).send(equipment);
    expect(response.status).toBe(401);
    expect(response.body.error).toMatch(/owner/);
  });
});
