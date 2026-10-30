import { describe, expect, it } from "vitest";
import { authorize, createRateLimiter, secretsMatch } from "../src/utils/security.js";
import { owner, testDeps } from "./helpers.js";

describe("telegram authentication", () => {
  it("hides data when the owner is not configured", () => {
    const decision = authorize({ ownerId: "", fromId: 42, chatType: "private" });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("unconfigured");
      expect(decision.message.toLowerCase()).not.toContain("task");
    }
  });

  it("rejects a different telegram account and group chats", () => {
    expect(authorize({ ownerId: "42", fromId: 7, chatType: "private" }).ok).toBe(false);
    const group = authorize({ ownerId: "42", fromId: 42, chatType: "group" });
    expect(group.ok).toBe(false);
    if (!group.ok) expect(group.reason).toBe("not_private");
    expect(authorize({ ownerId: "42", fromId: 42, chatType: "private" }).ok).toBe(true);
  });

  it("compares secrets without accepting a missing value", () => {
    expect(secretsMatch("hook_secret", "hook_secret")).toBe(true);
    expect(secretsMatch("hook_secret", "other_secret")).toBe(false);
    expect(secretsMatch(undefined, "hook_secret")).toBe(false);
    expect(secretsMatch("hook_secret", "")).toBe(false);
  });

  it("rate limits a burst from one sender", () => {
    const limiter = createRateLimiter(2, 10_000);
    expect(limiter.allow("42", 1_000)).toBe(true);
    expect(limiter.allow("42", 1_100)).toBe(true);
    expect(limiter.allow("42", 1_200)).toBe(false);
  });

  it("records an update only once", async () => {
    const { db } = testDeps();
    await owner(db);
    expect(await db.claimUpdate(10, 42, "2026-10-30T06:00:00.000Z")).toBe(true);
    expect(await db.claimUpdate(10, 42, "2026-10-30T06:00:00.000Z")).toBe(false);
  });
});
