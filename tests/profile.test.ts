import { readFileSync } from "node:fs";
import type { BotCommand } from "grammy/types";
import { describe, expect, it } from "vitest";
import {
  BOT_COMMANDS,
  BOT_DESCRIPTION,
  BOT_SHORT_DESCRIPTION,
  GROUP_COMMANDS,
  syncBotProfile,
} from "../src/bot/profile.js";

type Scope = { type: string };

/** A fake profile API. `current` is what Telegram has now; every call is recorded. */
function fakeApi(current: { private?: BotCommand[]; group?: BotCommand[]; description?: string; short?: string }, failOn?: string) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record = (method: string, args: unknown[]) => {
    calls.push({ method, args });
    if (method === failOn) throw new Error(`${method} failed for https://api.telegram.org/bot123456:test-token-value/${method}`);
  };
  const api = {
    async getMyCommands(other?: { scope?: Scope }) {
      record("getMyCommands", [other]);
      return (other?.scope?.type === "all_group_chats" ? current.group : current.private) ?? [];
    },
    async setMyCommands(commands: BotCommand[], other?: { scope?: Scope }) {
      record("setMyCommands", [commands, other]);
      return true as const;
    },
    async getMyDescription() {
      record("getMyDescription", []);
      return { description: current.description ?? "" };
    },
    async setMyDescription(description: string) {
      record("setMyDescription", [description]);
      return true as const;
    },
    async getMyShortDescription() {
      record("getMyShortDescription", []);
      return { short_description: current.short ?? "" };
    },
    async setMyShortDescription(shortDescription: string) {
      record("setMyShortDescription", [shortDescription]);
      return true as const;
    },
  };
  return { api: api as unknown as Parameters<typeof syncBotProfile>[0], calls };
}

function recordingLogger() {
  const warnings: Array<Record<string, unknown>> = [];
  return { logger: { info() {}, warn(obj: Record<string, unknown>) { warnings.push(obj); }, error() {}, debug() {} }, warnings };
}

const setters = (calls: Array<{ method: string }>) => calls.filter((call) => call.method.startsWith("set")).map((call) => call.method);
const UP_TO_DATE = { private: BOT_COMMANDS, group: GROUP_COMMANDS, description: BOT_DESCRIPTION, short: BOT_SHORT_DESCRIPTION };

describe("syncBotProfile", () => {
  it("sets the commands for both scopes, and the descriptions, when they differ", async () => {
    const { api, calls } = fakeApi({ private: [{ command: "start", description: "Old" }] });
    await syncBotProfile(api, recordingLogger().logger);
    expect(calls.filter((call) => call.method === "setMyCommands").map((call) => call.args)).toEqual([
      [BOT_COMMANDS, { scope: { type: "all_private_chats" } }],
      [GROUP_COMMANDS, { scope: { type: "all_group_chats" } }],
    ]);
    expect(calls.find((call) => call.method === "setMyDescription")?.args).toEqual([BOT_DESCRIPTION]);
    expect(calls.find((call) => call.method === "setMyShortDescription")?.args).toEqual([BOT_SHORT_DESCRIPTION]);
  });

  it("calls no setters when everything already matches", async () => {
    const { api, calls } = fakeApi(UP_TO_DATE);
    await syncBotProfile(api, recordingLogger().logger);
    expect(setters(calls)).toEqual([]);
    expect(calls.map((call) => call.method)).toEqual(["getMyCommands", "getMyCommands", "getMyDescription", "getMyShortDescription"]);
  });

  it("updates only the field that changed", async () => {
    const { api, calls } = fakeApi({ ...UP_TO_DATE, short: "Old text" });
    await syncBotProfile(api, recordingLogger().logger);
    expect(setters(calls)).toEqual(["setMyShortDescription"]);
  });

  it("resolves and logs a redacted warning when a setter throws, and still syncs the rest", async () => {
    const { api, calls } = fakeApi({}, "setMyCommands");
    const { logger, warnings } = recordingLogger();
    await expect(syncBotProfile(api, logger)).resolves.toBeUndefined();
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatchObject({ event: "bot_profile_failed", field: "private_commands" });
    expect(JSON.stringify(warnings)).not.toContain("test-token-value");
    expect(setters(calls)).toContain("setMyDescription");
    expect(setters(calls)).toContain("setMyShortDescription");
  });

  it("keeps descriptions inside Telegram's limits", () => {
    expect(BOT_DESCRIPTION.length).toBeLessThanOrEqual(512);
    expect(BOT_SHORT_DESCRIPTION.length).toBeLessThanOrEqual(120);
    for (const item of [...BOT_COMMANDS, ...GROUP_COMMANDS]) {
      expect(item.command).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(item.description.length).toBeGreaterThanOrEqual(1);
      expect(item.description.length).toBeLessThanOrEqual(256);
    }
  });
});

describe("BOT_COMMANDS", () => {
  it("covers exactly the commands registered in src/bot/index.ts", () => {
    const source = readFileSync(new URL("../src/bot/index.ts", import.meta.url), "utf8");
    const registered = [...source.matchAll(/bot\.command\(\s*"([a-z0-9_]+)"/g)].map((match) => match[1]);
    expect(registered.length).toBeGreaterThan(0);
    expect(BOT_COMMANDS.map((item) => item.command).sort()).toEqual([...registered].sort());
  });

  it("offers only registered commands in groups", () => {
    const names = new Set(BOT_COMMANDS.map((item) => item.command));
    expect(GROUP_COMMANDS.every((item) => names.has(item.command))).toBe(true);
  });
});
