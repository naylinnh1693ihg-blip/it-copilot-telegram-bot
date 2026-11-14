import type { Context } from "grammy";
import { describe, expect, it } from "vitest";
import { sendReply } from "../src/bot/handlers/messages.js";
import { execute } from "../src/services/assistant/execute.js";
import { formatRichSummary, summarizeDocument } from "../src/services/documents/grokSummarizer.js";
import type { LlmClient } from "../src/services/grok/client.js";
import { blankIntent } from "../src/types/intent.js";
import { escapeRichBlock, escapeRichInline, escapeRichMarkdown, richTable } from "../src/utils/richMarkdown.js";
import { owner, testDeps } from "./helpers.js";

/** True when every ASCII punctuation character is preceded by a backslash. */
function fullyEscaped(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (!/[!-/:-@[-`{-~]/.test(char)) continue;
    if (char === "\\" && /[!-/:-@[-`{-~]/.test(text[index + 1] ?? "")) {
      index += 1;
      continue;
    }
    return false;
  }
  return true;
}

describe("escapeRichMarkdown", () => {
  const attacks = [
    "[click here](https://evil.example/login)",
    '<tg-button type="url" url="https://evil.example">Verify account</tg-button>',
    '<tg-button type="callback_data" data="c:yes">Confirm</tg-button>',
    "![](https://evil.example/tracker.gif)",
    "**bold** __bold__ *it* _it_ ~~strike~~ ==mark== ||spoiler|| `code`",
    "$x^2$ and $$E = mc^2$$",
    "footnote[^1]\n[^1]: https://evil.example",
    "&lt;b&gt; &amp; <b>html</b>",
    "back\\slash \\*not bold\\*",
  ];

  it.each(attacks)("neutralises %s", (attack) => {
    const escaped = escapeRichMarkdown(attack);
    expect(fullyEscaped(escaped.replace(/\n/g, ""))).toBe(true);
    expect(escaped).not.toMatch(/(^|[^\\])[<[*_~=|`$]/);
  });

  it("escapes block syntax at the start of a line", () => {
    const escaped = escapeRichBlock("# Heading\n> quote\n- item\n+ item\n1. item\n---\n    indented code\n| a | b |");
    expect(escaped).toBe(["\\# Heading", "\\> quote", "\\- item", "\\+ item", "1\\. item", "\\-\\-\\-", "indented code", "\\| a \\| b \\|"].join("\n\n"));
  });

  it("keeps plain words, digits and non-ASCII text as they are, and drops control characters", () => {
    expect(escapeRichMarkdown("Printer 2 Kitchen ÄÖÜ مرحبا 👍")).toBe("Printer 2 Kitchen ÄÖÜ مرحبا 👍");
    expect(escapeRichMarkdown("a\u0000b\u0007c\td")).toBe("abc\td");
    expect(escapeRichMarkdown("10.0.0.1")).toBe("10\\.0\\.0\\.1");
  });

  it("puts multi-line text on one line for inline use", () => {
    expect(escapeRichInline("  first\n  second  ")).toBe("first second");
  });
});

describe("richTable", () => {
  it("drops columns that are empty in every row", () => {
    const table = richTable(["printer", "scannerIP", "IP", "notes"], [["BOH", "", "10.0.0.1", ""], ["Kitchen", " ", "10.0.0.2", ""]]);
    expect(table?.markdown).toBe(["| printer | IP |", "| --- | --- |", "| BOH | 10\\.0\\.0\\.1 |", "| Kitchen | 10\\.0\\.0\\.2 |"].join("\n"));
    expect(table?.droppedColumns).toBe(0);
  });

  it("keeps at most 20 columns and reports how many were left out", () => {
    const headers = Array.from({ length: 25 }, (_value, index) => `c${index + 1}`);
    const rows = [headers.map((header) => `${header}v`)];
    const table = richTable(headers, rows);
    const header = table?.markdown.split("\n")[0] ?? "";
    expect(header.split("|").filter((cell) => cell.trim()).length).toBe(20);
    expect(header).toContain("c20");
    expect(header).not.toContain("c21");
    expect(table?.droppedColumns).toBe(5);
  });

  it("escapes cells, so a pipe can't add a column and a link can't be injected", () => {
    const table = richTable(["name", "note"], [["a|b", "[x](https://evil.example)"]]);
    expect(table?.markdown.split("\n")[2]).toBe("| a\\|b | \\[x\\]\\(https\\:\\/\\/evil\\.example\\) |");
  });

  it("returns null when nothing is left to show", () => {
    expect(richTable(["a", "b"], [["", ""]])).toBeNull();
    expect(richTable(["a"], [])).toBeNull();
  });
});

describe("rich document summary", () => {
  const analysis = {
    notes: ["Upgrade review is due on **15 November**.", "Click [here](https://evil.example) <tg-button>x</tg-button>"],
    summary: "Short summary.",
    language: "en",
  };

  it("uses headings and a list, and escapes model output", () => {
    const markdown = formatRichSummary(analysis);
    expect(markdown).toContain("## Key notes\n\n- Upgrade review is due on \\*\\*15 November\\*\\*\\.");
    expect(markdown).toContain("\\[here\\]\\(https\\:\\/\\/evil\\.example\\) \\<tg\\-button\\>");
    expect(markdown).toContain("## Summary\n\nShort summary\\.");
    expect(markdown).not.toContain("<details>");
  });

  it("folds a long summary into a collapsible block", () => {
    const markdown = formatRichSummary({ ...analysis, summary: "Long sentence. ".repeat(60) });
    expect(markdown).toMatch(/## Summary\n\n<details><summary>Show the full summary<\/summary>\n\nLong sentence\\\./);
    expect(markdown).toContain("</details>");
  });

  function analysisLlm(): LlmClient {
    return {
      async completeStructured() {
        throw new Error("not used");
      },
      async completeText() {
        throw new Error("not used");
      },
      async streamStructured() {
        return { text: JSON.stringify({ key_notes: [{ text: "Three switches need firmware." }], summary: "Firmware review.", language: "en" }), inputTokens: 1, outputTokens: 1 };
      },
    };
  }

  it("adds richMarkdown only when the flag is on, and keeps MarkdownV2 as the text", async () => {
    const off = testDeps();
    off.deps.llm = analysisLlm();
    const plain = await summarizeDocument(off.deps, await owner(off.db), "source");
    expect(plain.richMarkdown).toBeUndefined();
    expect(plain.parseMode).toBe("MarkdownV2");

    const on = testDeps({ TELEGRAM_RICH_MESSAGES: "true" });
    on.deps.llm = analysisLlm();
    const rich = await summarizeDocument(on.deps, await owner(on.db), "source");
    expect(rich.richMarkdown).toContain("## Key notes");
    expect(rich.text).toBe(plain.text);
    expect(rich.parseMode).toBe("MarkdownV2");
  });
});

describe("inventory lookups", () => {
  const HEADER = "printer;location;IPAddress;scannerIP;terminalID;slaveTerminalID;enforcedModel;assetNumber;contact;purchaseDate;Model ;Serial number;MAC;B&W print;Color print";
  async function setup(flag: boolean) {
    const { deps, db } = testDeps(flag ? { TELEGRAM_RICH_MESSAGES: "true" } : {});
    const user = await owner(db);
    await db.insertNote({
      userId: user.id,
      title: "printers",
      content: [
        HEADER,
        "Reception;Floor 1;10.1.1.10;;T1;;Hewlett;A-100;Sam;;LaserJet;SN1;AA:BB;100;20",
        "Floor2;Floor 2;192.168.1.10;;T3;;Hewlett;A-200;Ann;;M404;SN2;CC:DD;50;10",
        "Kitchen;Floor 3;10.3.3.3;;T5;;Kyocera;A-300;Bo;;P-4026;SN3;EE:FF;5;1",
      ].join("\n"),
      category: "",
      tags: [],
      createdAt: "2026-10-30T10:00:00.000+04:00",
    });
    return { deps, user };
  }

  it("sends a table when more than one row matches, without empty columns", async () => {
    const { deps, user } = await setup(true);
    const reply = await execute(deps, user, blankIntent({ intent: "search_notes", search_query: "Hewlett" }), { confirmed: false });
    expect(reply.richMarkdown).toContain("Note \\#1\\: 2 matches");
    expect(reply.richMarkdown).toContain("| printer | location | IPAddress | terminalID |");
    expect(reply.richMarkdown).toContain("| Reception | Floor 1 | 10\\.1\\.1\\.10 | T1 |");
    expect(reply.richMarkdown).not.toContain("scannerIP");
    expect(reply.richMarkdown).not.toContain("Kitchen");
  });

  it("keeps the plain card for a single match", async () => {
    const { deps, user } = await setup(true);
    const reply = await execute(deps, user, blankIntent({ intent: "search_notes", search_query: "192.168.1.10" }), { confirmed: false });
    expect(reply.richMarkdown).toBeUndefined();
    expect(reply.text).toContain("IPAddress: 192.168.1.10");
  });

  it("with the flag off, gives exactly the old reply", async () => {
    const on = await setup(true);
    const off = await setup(false);
    const intent = blankIntent({ intent: "search_notes", search_query: "Hewlett" });
    const richReply = await execute(on.deps, on.user, intent, { confirmed: false });
    const plainReply = await execute(off.deps, off.user, intent, { confirmed: false });
    expect(plainReply.richMarkdown).toBeUndefined();
    expect(plainReply.text).toBe(richReply.text);
  });
});

describe("sendReply with rich messages", () => {
  function fakeCtx(richError?: { error_code: number; description: string; message: string }) {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const ctx = {
      replyWithRichMessage: async (...args: unknown[]) => {
        calls.push({ method: "sendRichMessage", args });
        if (richError) throw Object.assign(new Error(richError.message), richError);
        return { message_id: 1 };
      },
      reply: async (...args: unknown[]) => {
        calls.push({ method: "sendMessage", args });
        return { message_id: 2 };
      },
    } as unknown as Context;
    return { ctx, calls };
  }
  const logger = () => {
    const warnings: Array<Record<string, unknown>> = [];
    return { log: { info() {}, warn(obj: Record<string, unknown>) { warnings.push(obj); }, error() {}, debug() {} }, warnings };
  };

  it("sends one rich message with the keyboard instead of text chunks", async () => {
    const { ctx, calls } = fakeCtx();
    await sendReply(ctx, { text: "x".repeat(9000), richMarkdown: "## Key notes\n\n- one", copyButtons: [{ label: "Copy IP 10.0.0.1", text: "10.0.0.1" }] });
    expect(calls.map((call) => call.method)).toEqual(["sendRichMessage"]);
    expect(calls[0]?.args[0]).toEqual({ markdown: "## Key notes\n\n- one" });
    expect(calls[0]?.args[1]).toHaveProperty("reply_markup");
  });

  it("falls back to the plain reply on a 400 and logs a redacted warning", async () => {
    const { ctx, calls } = fakeCtx({
      error_code: 400,
      description: "Bad Request: can't parse rich message",
      message: "Call to 'sendRichMessage' failed! (400: Bad Request) https://api.telegram.org/bot123456:test-token-value/sendRichMessage",
    });
    const { log, warnings } = logger();
    await sendReply(ctx, { text: "*KEY NOTES:*", parseMode: "MarkdownV2", richMarkdown: "## Key notes" }, log);
    expect(calls.map((call) => call.method)).toEqual(["sendRichMessage", "sendMessage"]);
    expect(calls[1]?.args).toEqual(["*KEY NOTES:*", { parse_mode: "MarkdownV2" }]);
    expect(warnings[0]?.event).toBe("rich_message_rejected");
    expect(JSON.stringify(warnings)).not.toContain("test-token-value");
  });

  it("does not hide other failures behind the fallback", async () => {
    const { ctx, calls } = fakeCtx({ error_code: 429, description: "Too Many Requests", message: "Too Many Requests: retry after 30" });
    await expect(sendReply(ctx, { text: "plain", richMarkdown: "## rich" })).rejects.toMatchObject({ error_code: 429 });
    expect(calls.map((call) => call.method)).toEqual(["sendRichMessage"]);
  });

  it("sends text as before when there is no rich version", async () => {
    const { ctx, calls } = fakeCtx();
    await sendReply(ctx, { text: "plain answer" });
    expect(calls.map((call) => call.method)).toEqual(["sendMessage"]);
  });
});
