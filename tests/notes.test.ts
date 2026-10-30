import { describe, expect, it } from "vitest";
import { handleText } from "../src/services/assistant/handleText.js";
import { draftIncidentReport } from "../src/services/assistant/reports.js";
import { disruptiveWarning, secretRisk } from "../src/utils/text.js";
import { owner, testDeps } from "./helpers.js";

describe("notes and knowledge", () => {
  it("saves explicit notes and retrieves them without inventing extra records", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    const saved = await handleText(deps, user, "Remember this: The meeting room printer uses a static IP.");
    expect(saved.text).toContain("Saved note 1");
    const found = await handleText(deps, user, "Find my old notes about DHCP.");
    expect(found.text).toContain("don't have anything saved");
    const printer = await handleText(deps, user, "What information did I save about the printer?");
    expect(printer.text).toContain("static IP");
    expect(printer.text).not.toContain("10.");
    const unclear = await handleText(deps, user, "Save this under Cisco networking.");
    expect(unclear.text).toContain("What should I save?");
    expect(await db.listKnowledge(user.id)).toHaveLength(0);
  });

  it("refuses passwords and asks before deleting a note", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    const refused = await handleText(deps, user, "Remember this: the password is hunter2.");
    expect(refused.text).toContain("didn't save");
    expect(await db.listNotes(user.id)).toHaveLength(0);
    expect(secretRisk("api_key=abcd1234")).toBeTruthy();
    await handleText(deps, user, "Remember this: Clear the print queue before replacing toner.");
    const ask = await handleText(deps, user, "Delete note 1.");
    expect(ask.text).toContain("YES");
    expect(await db.listNotes(user.id)).toHaveLength(1);
    await handleText(deps, user, "YES");
    expect(await db.listNotes(user.id)).toHaveLength(0);
  });

  it("warns about disruptive commands and does not invent an incident cause", () => {
    expect(disruptiveWarning("write erase")).toContain("disrupt");
    const report = draftIncidentReport(
      "I had a Wi-Fi problem in the meeting room. The access point was online but users could not connect. Help me prepare a professional incident report.",
    );
    expect(report.text).toContain("meeting room");
    expect(report.text).toContain("access point was online");
    expect(report.missing).toContain("When it started");
    expect(report.text).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
    expect(report.text.toLowerCase()).not.toContain("root cause was");
  });
});
