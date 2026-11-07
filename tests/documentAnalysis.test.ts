import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { analyzeStoredDocument } from "../src/services/documents/imageRead.js";
import { NOW, owner, testDeps } from "./helpers.js";
import { chooseAnalysisModel } from "../src/services/documents/analysisModel.js";
import { parseDocumentAnalysis, previewDocumentAnalysis, summarizeDocument, truncateDocumentForAnalysis } from "../src/services/documents/grokSummarizer.js";
import { AppError } from "../src/utils/errors.js";

const MODEL_ANALYSIS = JSON.stringify({
  key_notes: [
    { text: "Upgrade review is due on 15 November." },
    { text: "Three access switches need firmware updates." },
  ],
  summary: "The team reviewed the Avaya administration guide. Three access switches require firmware updates. The upgrade review is due on 15 November.",
  language: "en",
});

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
    let schemaName = "";
    deps.llm = {
      async completeStructured() {
        throw new Error("not used");
      },
      async completeText() {
        throw new Error("not used");
      },
      async streamStructured(input) {
        systemPrompt = input.system;
        userPrompt = input.user;
        schemaName = input.schemaName;
        expect(input.schema).toMatchObject({
          required: ["key_notes", "summary", "language"],
          additionalProperties: false,
        });
        return { text: MODEL_ANALYSIS, inputTokens: 50, outputTokens: 30 };
      },
    };

    const reply = await summarizeDocument(deps, user, "Avaya review source text.");
    expect(schemaName).toBe("document_analysis");
    expect(systemPrompt).toContain("3–6 sentences");
    expect(systemPrompt).toContain("language");
    expect(userPrompt).toContain("<untrusted_document>");
    expect(reply.parseMode).toBe("MarkdownV2");
    expect(reply.text).toContain("*KEY NOTES:*");
    expect(reply.text).toContain("• Upgrade review is due on 15 November\\.");
    expect(reply.text).toContain("*SUMMARY:*");
    expect(reply.text).toContain("15 November");
    expect(reply.text).toContain("Language: en");
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
        throw new Error("not used");
      },
      async streamStructured() {
        return {
          text: JSON.stringify({
            key_notes: [{ text: "Network finding. ".repeat(50) }],
            summary: "The report covers the network findings. ".repeat(200),
            language: "en",
          }),
          inputTokens: 10,
          outputTokens: 10,
        };
      },
    };

    const reply = await summarizeDocument(deps, user, "A long source document.");
    expect(reply.text.length).toBeLessThanOrEqual(3_500);
    expect(reply.text).toContain("…");
    expect(reply.text.endsWith("Language: en")).toBe(true);
  });

  it("reports empty text and invalid Grok structure instead of inventing an analysis", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    await expect(summarizeDocument(deps, user, " \n ")).rejects.toBeInstanceOf(AppError);
    deps.llm = {
      async completeStructured() {
        return { text: "Not an analysis.", inputTokens: 0, outputTokens: 0 };
      },
      async completeText() {
        throw new Error("not used");
      },
    };
    await expect(summarizeDocument(deps, user, "source")).rejects.toThrow("unexpected format");
    deps.llm.streamStructured = async () => ({
      text: JSON.stringify({ key_notes: [], summary: "Only a summary.", language: "en" }),
      inputTokens: 0,
      outputTokens: 0,
    });
    await expect(summarizeDocument(deps, user, "source")).rejects.toThrow("incomplete");
  });

  it("sends a photo to Grok when OCR finds no text", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    let images: Array<{ mime: string; base64: string }> | undefined;
    let userPrompt = "";
    deps.llm = {
      async completeStructured() {
        throw new Error("not used");
      },
      async completeText() {
        throw new Error("not used");
      },
      async streamStructured(input) {
        images = input.images;
        userPrompt = input.user;
        return { text: MODEL_ANALYSIS, inputTokens: 20, outputTokens: 10 };
      },
    };

    const reply = await summarizeDocument(deps, user, "   ", false, [{ mime: "image/jpeg", data: Buffer.from("whiteboard") }]);
    expect(images).toEqual([{ mime: "image/jpeg", base64: Buffer.from("whiteboard").toString("base64") }]);
    expect(userPrompt).toContain("No text could be extracted");
    expect(userPrompt).toContain("Extract visible text");
    expect(userPrompt).toContain("<untrusted_document>");
    expect(reply.text).toContain("*KEY NOTES:*");
  });

  it("turns partial JSON into a readable preview and accepts the final schema", () => {
    const partial = '{"key_notes":[{"text":"VLAN 20 is the guest network."},{"text":"Review is due on 15 November."}],"summary":"The board lists VLAN';
    const preview = previewDocumentAnalysis(partial);
    expect(preview).toContain("• VLAN 20 is the guest network.");
    expect(preview).toContain("• Review is due on 15 November.");
    expect(preview).toContain("The board lists VLAN");
    expect(preview).not.toContain("{");
    expect(parseDocumentAnalysis(MODEL_ANALYSIS).language).toBe("en");
  });

  it("publishes plain-text previews while the structured response is still arriving", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    const previews: string[] = [];
    deps.llm = {
      async completeStructured() {
        throw new Error("not used");
      },
      async completeText() {
        throw new Error("not used");
      },
      async streamStructured(input) {
        await input.onDelta?.('{"key_notes":[{"text":"Call the network team."}]');
        await input.onDelta?.(MODEL_ANALYSIS);
        return { text: MODEL_ANALYSIS, inputTokens: 4, outputTokens: 4 };
      },
    };

    await summarizeDocument(deps, user, "A short note.", false, [], "", async (text) => {
      previews.push(text);
    });
    expect(previews[0]).toBe("Analyzing the document…");
    expect(previews.some((text) => text.includes("• Call the network team."))).toBe(true);
    expect(previews.at(-1)).toContain("• Upgrade review is due on 15 November.");
  });

  it("routes document analysis by estimated tokens and keeps streaming structured output", async () => {
    const config = {
      standardModel: "grok-4.7",
      longModel: "grok-4.20",
      maxModel: "grok-4.3",
      standardTokenLimit: 120_000,
      longTokenLimit: 400_000,
    };
    expect(chooseAnalysisModel("a".repeat(40), config)).toMatchObject({ model: "grok-4.7", estimatedTokens: 10, truncateToChars: null });
    expect(chooseAnalysisModel("a".repeat(120_000 * 4), config)).toMatchObject({ model: "grok-4.20", estimatedTokens: 120_000 });
    expect(chooseAnalysisModel("a".repeat(400_000 * 4 + 4), config)).toMatchObject({
      model: "grok-4.3",
      estimatedTokens: 400_001,
      truncateToChars: 1_600_000,
    });

    const { deps, db } = testDeps({
      XAI_ANALYSIS_STANDARD_TOKENS: "8",
      XAI_ANALYSIS_LONG_TOKENS: "20",
      XAI_MODEL_LONG: "grok-4.20",
      XAI_MODEL_MAX: "grok-4.3",
    });
    const user = await owner(db);
    const logged: Array<Record<string, unknown>> = [];
    deps.logger = { ...deps.logger, info: (obj) => logged.push(obj) };
    let model = "";
    deps.llm = {
      async completeStructured() {
        throw new Error("streaming path should be used");
      },
      async completeText() {
        throw new Error("not used");
      },
      async streamStructured(input) {
        model = input.model ?? "";
        expect(input.schemaName).toBe("document_analysis");
        expect(input.user).toContain("BEGIN");
        expect(input.user).toContain("END");
        expect(input.user).toContain("Middle of document omitted");
        return { text: MODEL_ANALYSIS, inputTokens: 5, outputTokens: 4 };
      },
    };

    const reply = await summarizeDocument(deps, user, `BEGIN ${"word ".repeat(30)} END`);
    expect(model).toBe("grok-4.3");
    expect(logged).toContainEqual(expect.objectContaining({ event: "document_analysis_model", model: "grok-4.3", truncated: true }));
    expect(reply.text).toContain("left out the middle");
    expect(reply.parseMode).toBe("MarkdownV2");
  });

  it("uses OCR text when vision cannot read the photo", async () => {
    const { deps, db, storage } = testDeps();
    const user = await owner(db);
    const path = `${user.id}/photo.jpg`;
    await storage.upload(path, Buffer.from("not-a-jpeg"), "image/jpeg");
    const document = await db.insertDocument({
      id: randomUUID(),
      userId: user.id,
      title: "Whiteboard",
      originalFilename: "photo.jpg",
      storagePath: path,
      mimeType: "image/jpeg",
      byteSize: 10,
      sha256: "photo-hash",
      category: "General",
      tags: [],
      createdAt: NOW,
    });
    await db.saveExtraction({ documentId: document.id, text: "VLAN 20 is the guest network.", truncated: false, extractedAt: NOW });
    let sawImage = false;
    deps.llm = {
      async completeStructured() {
        throw new Error("not used");
      },
      async completeText() {
        throw new Error("not used");
      },
      async streamStructured(input) {
        sawImage = (input.images?.length ?? 0) > 0;
        return { text: MODEL_ANALYSIS, inputTokens: 3, outputTokens: 2 };
      },
    };
    const reply = await analyzeStoredDocument(deps, user, document, await db.getExtraction(document.id));
    expect(sawImage).toBe(false);
    expect(reply.text).toContain("*KEY NOTES:*");
  });

  it("stays on OCR when vision is disabled", async () => {
    const { deps, db, storage } = testDeps({ VISION_MODE: "ocr" });
    const user = await owner(db);
    const path = `${user.id}/shot.jpg`;
    await storage.upload(path, Buffer.from("unused"), "image/jpeg");
    const document = await db.insertDocument({
      id: randomUUID(),
      userId: user.id,
      title: "Screenshot",
      originalFilename: "shot.jpg",
      storagePath: path,
      mimeType: "image/jpeg",
      byteSize: 6,
      sha256: "shot-hash",
      category: "General",
      tags: [],
      createdAt: NOW,
    });
    await db.saveExtraction({ documentId: document.id, text: "Printer queue is paused.", truncated: false, extractedAt: NOW });
    let images = 0;
    deps.llm = {
      async completeStructured() {
        throw new Error("not used");
      },
      async completeText() {
        throw new Error("not used");
      },
      async streamStructured(input) {
        images = input.images?.length ?? 0;
        return { text: MODEL_ANALYSIS, inputTokens: 1, outputTokens: 1 };
      },
    };
    await analyzeStoredDocument(deps, user, document, await db.getExtraction(document.id));
    expect(images).toBe(0);
  });

  it("stores Key Notes with the document text and does not duplicate them on a second analysis", async () => {
    const { deps, db, storage } = testDeps({ VISION_MODE: "ocr" });
    const user = await owner(db);
    const path = `${user.id}/network.txt`;
    const body = `Core switch core-sw1 uses 10.0.0.1. ${"VLAN 20 is the guest network. ".repeat(40)}`;
    await storage.upload(path, Buffer.from(body), "text/plain");
    const document = await db.insertDocument({
      id: randomUUID(),
      userId: user.id,
      title: "Network-Map.txt",
      originalFilename: "Network-Map.txt",
      storagePath: path,
      mimeType: "text/plain",
      byteSize: body.length,
      sha256: "network-hash",
      category: "Network",
      tags: [],
      createdAt: NOW,
    });
    await db.saveExtraction({ documentId: document.id, text: body, truncated: false, extractedAt: NOW });
    deps.llm = {
      async completeStructured() {
        throw new Error("not used");
      },
      async completeText() {
        throw new Error("not used");
      },
      async streamStructured() {
        return { text: MODEL_ANALYSIS, inputTokens: 4, outputTokens: 4 };
      },
    };
    const reply = await analyzeStoredDocument(deps, user, document, await db.getExtraction(document.id));
    expect(reply.text).toContain("*KEY NOTES:*");
    const first = await db.listChunks(user.id, "document", document.id);
    expect(first.some((chunk) => chunk.content.includes("Key notes:") && chunk.content.includes("Upgrade review is due on 15 November."))).toBe(true);
    expect(first.some((chunk) => chunk.content.includes("10.0.0.1"))).toBe(true);
    await analyzeStoredDocument(deps, user, document, await db.getExtraction(document.id));
    const second = await db.listChunks(user.id, "document", document.id);
    expect(second).toHaveLength(first.length);
  });
});
