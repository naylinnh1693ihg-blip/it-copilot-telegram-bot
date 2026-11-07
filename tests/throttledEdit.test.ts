import { describe, expect, it } from "vitest";
import { classifyTelegramEditError, createThrottledEdit, streamingWindow } from "../src/bot/throttledEdit.js";
import type { AppLogger } from "../src/utils/logger.js";

function logger(): { log: AppLogger; events: string[] } {
  const events: string[] = [];
  const log = {
    info(obj: Record<string, unknown>) {
      events.push(String(obj.event));
    },
    warn(obj: Record<string, unknown>) {
      events.push(String(obj.event));
    },
    error() {},
    debug() {},
  };
  return { log, events };
}

describe("throttled telegram edits", () => {
  it("keeps the newest text and edits about once per interval", async () => {
    const sent: string[] = [];
    let time = 1_000;
    const editor = createThrottledEdit({
      minIntervalMs: 1_100,
      now: () => time,
      edit: async (text) => {
        sent.push(text);
      },
    });
    await editor.push("one");
    await editor.push("two");
    await editor.push("three");
    time = 2_200;
    await editor.push("four");
    expect(sent).toEqual(["one", "four"]);
  });

  it("always sends the final text inside the throttle window", async () => {
    const sent: string[] = [];
    const editor = createThrottledEdit({
      minIntervalMs: 1_100,
      now: () => 0,
      edit: async (text) => {
        sent.push(text);
      },
    });
    await editor.push("preview");
    expect(await editor.flush("Final answer.")).toBe(true);
    expect(sent).toEqual(["preview", "Final answer."]);
  });

  it("waits for retry_after after a 429 and then finishes", async () => {
    let time = 0;
    let calls = 0;
    const { log, events } = logger();
    const editor = createThrottledEdit({
      minIntervalMs: 1_100,
      now: () => time,
      sleep: async (ms) => {
        time += ms;
      },
      log,
      edit: async () => {
        calls += 1;
        if (calls === 1) {
          throw Object.assign(new Error("Too Many Requests"), {
            error_code: 429,
            description: "Too Many Requests: retry after 2",
            parameters: { retry_after: 2 },
          });
        }
      },
    });
    expect(await editor.flush("Done.")).toBe(true);
    expect(calls).toBe(2);
    expect(time).toBe(2_000);
    expect(events).toContain("telegram_edit_limited");
  });

  it("treats an unchanged message as a successful edit", async () => {
    const editor = createThrottledEdit({
      minIntervalMs: 1_100,
      edit: async () => {
        throw Object.assign(new Error("not modified"), { error_code: 400, description: "Bad Request: message is not modified" });
      },
    });
    expect(await editor.flush("Same text")).toBe(true);
    expect(classifyTelegramEditError(Object.assign(new Error("x"), { description: "message is not modified" })).notModified).toBe(true);
  });

  it("shows only the latest window while streaming", () => {
    const text = `${"a".repeat(100)}${"z".repeat(3_900)}`;
    const window = streamingWindow(text);
    expect(window.length).toBeLessThanOrEqual(3_900);
    expect(window.endsWith("z")).toBe(true);
    expect(window.startsWith("…")).toBe(true);
  });
});
