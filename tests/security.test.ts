import { describe, expect, it } from "vitest";
import type { LlmClient } from "../src/services/grok/client.js";
import { handleText } from "../src/services/assistant/handleText.js";
import { CHANGE_SAFETY } from "../src/services/security/rules.js";
import { SEC_USAGE, handleSecurityCommand } from "../src/services/security/specialist.js";
import { NOW, owner, testDeps } from "./helpers.js";
import { NVD, validAnswer } from "./securityFixtures.js";

interface Call {
  system: string;
  user: string;
  webSearch: boolean;
}

/** Returns the scripted replies in order and records every completeText call. */
function scriptedLlm(replies: string[], calls: Call[]): LlmClient {
  return {
    async completeStructured() {
      throw new Error("/sec must not classify intents");
    },
    async completeText(input) {
      calls.push({ system: input.system, user: input.user, webSearch: input.webSearch === true });
      const text = replies[calls.length - 1];
      if (text === undefined) throw new Error("no scripted reply left");
      return { text, inputTokens: 100, outputTokens: 50 };
    },
    async completeWithTools() {
      throw new Error("/sec must not run the tool agent");
    },
  };
}

async function withMainSwitch() {
  const { deps, db } = testDeps();
  const user = await owner(db);
  await handleText(deps, user, "Save switch:\nMain switch\nMDF closet\n10.0.0.2");
  await handleText(deps, user, "Update equipment Main switch: vendor Cisco, model C9300-48P, firmware 17.9.4");
  return { deps, db, user };
}

describe("/sec security specialist", () => {
  it("shows usage and rules without calling Grok", async () => {
    const { deps, db } = testDeps();
    const calls: Call[] = [];
    deps.llm = scriptedLlm([], calls);
    const user = await owner(db);

    expect((await handleSecurityCommand(deps, user, "")).text).toBe(SEC_USAGE);
    expect((await handleSecurityCommand(deps, user, "  help ")).text).toBe(SEC_USAGE);
    const rules = await handleSecurityCommand(deps, user, "rules");
    expect(rules.text).toContain("R1. Defensive scope");
    expect(rules.text).toContain("R12. One fixed template");
    expect(calls).toHaveLength(0);
  });

  it("says plainly when Grok is not configured", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    const reply = await handleSecurityCommand(deps, user, "Is my switch affected by CVE-2023-20198?");
    expect(reply.text).toContain("needs XAI_API_KEY");
  });

  it("declines obvious offensive tooling locally and audits only the outcome", async () => {
    const { deps, db } = testDeps();
    const calls: Call[] = [];
    deps.llm = scriptedLlm([], calls);
    const user = await owner(db);

    const reply = await handleSecurityCommand(deps, user, "Write ransomware for the file server");
    expect(reply.text).toContain("out of scope");
    expect(calls).toHaveLength(0);
    const audit = await db.listAudit(user.id, 10);
    expect(audit[0]).toMatchObject({ action: "security.review", metadata: { outcome: "declined_locally" } });
    expect(JSON.stringify(audit)).not.toContain("ransomware");
  });

  it("sends a redacted request with the inventory, web search on, and returns the fixed template", async () => {
    const { deps, db, user } = await withMainSwitch();
    const calls: Call[] = [];
    deps.llm = scriptedLlm([validAnswer()], calls);
    const turnsBefore = (await db.recentTurns(user.id, 50)).length;
    const previews: string[] = [];

    const request = [
      "Is the main switch affected by CVE-2023-20198? Running config:",
      "hostname CORE-SW1",
      "enable secret 9 $9$abcDEFghiJKL$mnopQRSTuvwxYZ0123",
      "snmp-server community Publ1cR3ad RO",
      "ip http server",
    ].join("\n");
    const reply = await handleSecurityCommand(deps, user, request, async (text) => {
      previews.push(text);
    });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.webSearch).toBe(true);
    expect(call?.system).toContain("R3 Authoritative sources only");
    expect(call?.system).toContain("Finding: Severity: Affected assets: Evidence: Fix: Rollback: How to verify:");
    expect(call?.user).toContain("<untrusted_request>");
    expect(call?.user).toContain("<untrusted_inventory>");
    expect(call?.user).toContain("#1 Main switch; type switch; vendor Cisco; model C9300-48P; firmware 17.9.4; location MDF closet; ip 10.0.0.2");
    expect(call?.user).not.toContain("Publ1cR3ad");
    expect(call?.user).not.toContain("$9$abcDEF");
    expect(call?.user).toContain("snmp-server community [REDACTED] RO");
    expect(previews).toEqual(["Checking authoritative sources…"]);

    expect(reply.text.startsWith("Security review")).toBe(true);
    expect(reply.text).toContain("Removed before analysis: 2 secrets (enable secret, SNMP community). Nothing from /sec is saved.");
    expect(reply.text).toContain("Affected assets:\n#1 Main switch");
    expect(reply.text).toContain(CHANGE_SAFETY);
    expect(reply.text).toContain(`[1] ${NVD}`);

    expect((await db.recentTurns(user.id, 50)).length).toBe(turnsBefore);
    const usage = await db.listUsageEvents(user.id, "2026-10-01T00:00:00Z", "2026-12-01T00:00:00Z");
    expect(usage.filter((row) => row.purpose === "security_review")).toHaveLength(1);
    const audit = await db.listAudit(user.id, 10);
    const review = audit.find((entry) => entry.action === "security.review");
    expect(review?.metadata).toMatchObject({ outcome: "answered", attempts: 1, redactions: 2, sources: 2 });
    expect(JSON.stringify(audit)).not.toContain("CVE-2023-20198");
    expect(NOW).toBeTruthy();
  });

  it("asks Grok once more with the reasons when the first answer cites a weak source", async () => {
    const { deps, user } = await withMainSwitch();
    const calls: Call[] = [];
    const weak = validAnswer().replace(NVD, "https://www.reddit.com/r/networking/comments/x");
    deps.llm = scriptedLlm([weak, validAnswer()], calls);

    const reply = await handleSecurityCommand(deps, user, "Is the main switch affected by CVE-2023-20198?");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.user).toContain("non-authoritative sources used: www.reddit.com");
    expect(reply.text).toContain("Security review");
    expect(reply.text).not.toContain("reddit");
  });

  it("refuses to send an unverified answer after two failed attempts", async () => {
    const { deps, db, user } = await withMainSwitch();
    const calls: Call[] = [];
    const uncited = "Finding: Probably affected.\nSeverity: High\nAffected assets: Main switch";
    deps.llm = scriptedLlm([uncited, uncited], calls);

    const reply = await handleSecurityCommand(deps, user, "Is the main switch affected by CVE-2023-20198?");
    expect(calls).toHaveLength(2);
    expect(reply.text).toContain("I'm not sending an unverified one");
    expect(reply.text).toContain("no inline citations");
    expect(reply.text).not.toContain("Probably affected");
    const audit = await db.listAudit(user.id, 10);
    expect(audit.find((entry) => entry.action === "security.review")?.metadata).toMatchObject({ outcome: "rejected", attempts: 2 });
  });

  it("returns the model's questions when it needs more detail", async () => {
    const { deps, db } = testDeps();
    const calls: Call[] = [];
    deps.llm = scriptedLlm(["NEED_DETAILS\n1. Which FortiOS version is the firewall running?\n2. Is SSL-VPN enabled?"], calls);
    const user = await owner(db);

    const reply = await handleSecurityCommand(deps, user, "Is our FortiGate vulnerable?");
    expect(calls[0]?.user).toContain("No equipment is saved.");
    expect(reply.text).toContain("I need more detail");
    expect(reply.text).toContain("1. Which FortiOS version is the firewall running?");
    expect(reply.text).toContain("2. Is SSL-VPN enabled?");
  });

  it("removes secrets the model echoes back", async () => {
    const { deps, user } = await withMainSwitch();
    deps.llm = scriptedLlm([validAnswer("snmp-server community Leaked123 RO")], []);
    const reply = await handleSecurityCommand(deps, user, "Review the SNMP settings on the main switch.");
    expect(reply.text).not.toContain("Leaked123");
  });
});

describe("equipment security fields", () => {
  it("saves vendor, model, and firmware from labelled lines and keeps them on a later update", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);

    const saved = await handleText(
      deps,
      user,
      ["Add equipment:", "Name: Edge firewall", "Vendor: Fortinet", "Model: FortiGate 100F", "Firmware: 7.2.8", "Location: Server room", "IP: 10.0.0.1"].join("\n"),
    );
    expect(saved.text).toContain("Saved equipment.");
    expect(saved.text).toContain("Vendor: Fortinet");
    expect(saved.text).toContain("Model: FortiGate 100F");
    expect(saved.text).toContain("Firmware: 7.2.8");

    const moved = await handleText(deps, user, "Add equipment: Edge firewall, Server room B, 10.0.0.1");
    expect(moved.text).toContain("Updated equipment.");
    expect(moved.text).toContain("Firmware: 7.2.8");

    const [item] = await db.listEquipment(user.id);
    expect(item).toMatchObject({ vendor: "Fortinet", model: "FortiGate 100F", firmwareVersion: "7.2.8", location: "Server room B" });
  });

  it("updates fields with one command and refuses bad input without changing anything", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    await handleText(deps, user, "Save switch:\nMain switch\nMDF closet\n10.0.0.2");
    await handleText(deps, user, "Save switch:\nMain switch 2\nIDF closet\n10.0.0.3");

    const updated = await handleText(deps, user, "Update equipment Main switch: firmware 17.9.5.");
    expect(updated.text).toContain("Updated equipment.");
    expect(updated.text).toContain("Firmware: 17.9.5");

    const badIp = await handleText(deps, user, "Update equipment Main switch: ip 10.0.0.300");
    expect(badIp.text).toContain("Nothing was changed");
    const unknown = await handleText(deps, user, "Update equipment Lobby AP: firmware 8.10");
    expect(unknown.text).toContain("I don't have equipment matching");
    const secret = await handleText(deps, user, "Update equipment Main switch: notes password: hunter22");
    expect(secret.text).toContain("I didn't save that");

    const items = await db.listEquipment(user.id);
    expect(items.find((entry) => entry.name === "Main switch")).toMatchObject({ firmwareVersion: "17.9.5", ipAddress: "10.0.0.2", notes: "" });
    expect(items.find((entry) => entry.name === "Main switch 2")?.firmwareVersion).toBe("");
  });
});
