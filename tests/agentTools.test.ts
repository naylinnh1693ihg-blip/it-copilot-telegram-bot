import { describe, expect, it } from "vitest";
import { handleText } from "../src/services/assistant/handleText.js";
import { selectTools, toolDefinitions } from "../src/services/grok/tools.js";
import type { AgentTurn } from "../src/services/grok/client.js";
import { owner, testDeps } from "./helpers.js";

describe("grok tools", () => {
  it("selects built-in and custom tools from the question", () => {
    expect(selectTools("What's the latest news about Cisco?")).toEqual(["web_search", "x_search"]);
    expect(selectTools("Calculate the average from this table: 4, 8, 12")).toEqual(["code_interpreter"]);
    expect(toolDefinitions(["web_search", "x_search", "code_interpreter"]).map((tool) => tool.type)).toEqual([
      "web_search",
      "x_search",
      "code_interpreter",
    ]);
    expect(selectTools("Show my pending tasks.")).toEqual([]);
  });

  it("answers latest-news questions with web and X search and does not classify an intent", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    let tools: Array<Record<string, unknown>> = [];
    deps.llm = {
      async completeStructured() {
        throw new Error("should not classify");
      },
      async completeText() {
        throw new Error("should not use the plain text path");
      },
      async completeWithTools(input) {
        tools = input.tools;
        return {
          text: "Cisco shipped a software advisory. [[1]](https://www.cisco.com/c/en/us/support/index.html).",
          inputTokens: 6,
          outputTokens: 4,
          functionCalls: [],
        } satisfies AgentTurn;
      },
    };

    const reply = await handleText(deps, user, "What's the latest news about Cisco?");
    expect(tools.map((tool) => tool.type)).toEqual(["web_search", "x_search"]);
    expect(reply.text).toContain("https://www.cisco.com/c/en/us/support/index.html");
    expect(reply.text).toContain("Sources:");
  });

  it("runs get_open_tasks and save_note on the server, then lets Grok answer", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    await handleText(deps, user, "Create a task to check the Cisco switches tomorrow.");

    const names: string[] = [];
    deps.llm = {
      async completeStructured() {
        throw new Error("should not classify");
      },
      async completeText() {
        throw new Error("unused");
      },
      async completeWithTools(input) {
        if (!input.input) {
          const name = input.user.includes("open tasks") ? "get_open_tasks" : "save_note";
          const args = name === "save_note" ? JSON.stringify({ title: "Guest VLAN", content: "VLAN 20 is the guest network." }) : "{}";
          return { text: "", inputTokens: 3, outputTokens: 2, functionCalls: [{ callId: "call_1", name, arguments: args }] };
        }
        const output = JSON.parse(String((input.input.at(-1) as { output: string }).output)) as { ok?: boolean; title?: string };
        names.push(output.title ?? "tasks");
        return {
          text: output.title ? `Saved note: ${output.title}.` : "You have 1 open task: check the Cisco switches.",
          inputTokens: 4,
          outputTokens: 3,
          functionCalls: [],
        };
      },
    };

    const open = await handleText(deps, user, "What are my open tasks?");
    expect(open.text).toContain("check the Cisco switches");

    const saved = await handleText(deps, user, "Make a note that VLAN 20 is the guest network.");
    expect(saved.text).toContain("Saved note: Guest VLAN");
    const notes = await db.listNotes(user.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.content).toContain("VLAN 20");
    expect(names).toContain("Guest VLAN");
  });

  it("creates tasks from the create_tasks tool", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    deps.llm = {
      async completeStructured() {
        throw new Error("should not classify");
      },
      async completeText() {
        throw new Error("unused");
      },
      async completeWithTools(input) {
        if (!input.input) {
          return {
            text: "",
            inputTokens: 3,
            outputTokens: 2,
            functionCalls: [{
              callId: "call_1",
              name: "create_tasks",
              arguments: JSON.stringify({ tasks: ["Fix the printer on floor 2", "Call vendor about the switch RMA"] }),
            }],
          };
        }
        const output = JSON.parse(String((input.input.at(-1) as { output: string }).output)) as { ok?: boolean; message?: string };
        expect(output.ok).toBe(true);
        return { text: output.message ?? "", inputTokens: 2, outputTokens: 2, functionCalls: [] };
      },
    };

    const reply = await handleText(deps, user, "Can you create tasks for the printer and the switch?");
    expect(reply.text).toContain("Created 2 tasks:");
    expect(reply.text).toContain("Fix the printer on floor 2");
    expect(await db.listTasks(user.id)).toHaveLength(2);
  });
});
