import { describe, expect, it } from "vitest";
import { owner, testDeps } from "./helpers.js";
import { summarizeDocument, truncateDocumentForAnalysis } from "../src/services/documents/grokSummarizer.js";
import { AppError } from "../src/utils/errors.js";

const MODEL_ANALYSIS = [
  "KEY NOTES:",
  "- Upgrade review is due on 15 November.",
  "- Three access switches need firmware updates.",
  "",
  "SUMMARY:",
  "The team reviewed the Avaya administration guide. Three access switches require firmware updates. The upgrade review is due on 15 November.",
].join("\n");

describe("document analysis", () => {
  it("truncates long source text by retaining its beginning and ending", () => {
    const text = `BEGIN\n${"middle details ".repeat(1_000)}\nEND`;
    const truncated = truncateDocumentForAnalysis(text);
    expect(truncated.length).toBeLessThanOrEqual(12_000);
    expect(truncated.startsWith("BEGIN")).toBe(true);
    expect(truncated.endsWith("END")).toBe(true);
    expect(truncated).toContain("Middle of document omitted");
  });

  it("asks Grok for the required structure and formats safe Markdown within Telegram limits", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    let systemPrompt = "";
    let userPrompt = "";
    deps.llm = {
      async completeStructured() {
        throw new Error("not used");
      },
      async completeText(input) {
        systemPrompt = input.system;
        userPrompt = input.user;
        return { text: MODEL_ANALYSIS, inputTokens: 50, outputTokens: 30 };
      },
    };

    const reply = await summarizeDocument(deps, user, "Avaya review source text.");
    expect(systemPrompt).toContain("KEY NOTES:");
    expect(systemPrompt).toContain("SUMMARY:");
    expect(systemPrompt).toContain("3–6 sentences");
    expect(userPrompt).toContain("<untrusted_document>");
    expect(reply.parseMode).toBe("MarkdownV2");
    expect(reply.text).toContain("*KEY NOTES:*");
    expect(reply.text).toContain("• Upgrade review is due on 15 November\\.");
    expect(reply.text).toContain("*SUMMARY:*");
    expect(reply.text).toContain("15 November");
    expect(reply.text.length).toBeLessThanOrEqual(3_500);
  });

  it("caps oversized model output without breaking Markdown or Telegram's message limit", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    deps.llm = {
      async completeStructured() {
        throw new Error("not used");
      },
      async completeText() {
        return {
          text: `KEY NOTES:\n- ${"Network finding. ".repeat(50)}\n\nSUMMARY:\n${"The report covers the network findings. ".repeat(200)}`,
          inputTokens: 10,
          outputTokens: 10,
        };
      },
    };

    const reply = await summarizeDocument(deps, user, "A long source document.");
    expect(reply.text.length).toBeLessThanOrEqual(3_500);
    expect(reply.text.endsWith("…")).toBe(true);
  });

  it("reports empty text and invalid Grok structure instead of inventing an analysis", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    await expect(summarizeDocument(deps, user, " \n ")).rejects.toBeInstanceOf(AppError);
    deps.llm = {
      async completeStructured() {
        throw new Error("not used");
      },
      async completeText() {
        return { text: "Not an analysis.", inputTokens: 0, outputTokens: 0 };
      },
    };
    await expect(summarizeDocument(deps, user, "source")).rejects.toThrow("unexpected format");
  });
});
