import { describe, expect, it } from "vitest";
import { blankIntent } from "../src/types/intent.js";
import { execute } from "../src/services/assistant/execute.js";
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

  it("returns only the matching fact from a pipe-delimited note", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    await db.insertNote({
      userId: user.id,
      title: "Network VLANs",
      content:
        "GRMS is VLAN 21 <172.21.4.0/22> | GP Policy = Meraki MGMT is VLAN 31 <172.31.8.0/24> | GP Policy = Staff_WLAN Digital Signage is VLAN 32 <172.32.8.0/24>",
      category: "",
      tags: [],
      createdAt: "2026-10-30T10:00:00.000+04:00",
    });

    const reply = await execute(
      deps,
      user,
      blankIntent({ intent: "search_notes", search_query: "Meraki MGMT VLAN" }),
      { confirmed: false },
    );

    expect(reply.text).toContain("• GP Policy: Meraki MGMT\n  VLAN: 31\n  Subnet: 172.31.8.0/24");
    expect(reply.text).toContain("Source: Note #1");
    expect(reply.text).not.toContain("GRMS");
    expect(reply.text).not.toContain("Staff_WLAN");
  });

  it("returns one printer row from a semicolon inventory instead of the whole note", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    const header =
      "printer;location;IPAddress;scannerIP;terminalID;slaveTerminalID;enforcedModel;assetNumber;contact;purchaseDate;Model ;Serial number;MAC;B&W print;Color print";
    await db.insertNote({
      userId: user.id,
      title: "printer informations",
      content: [
        `printer informations: ${header}`,
        "Reception;Floor 1;10.1.1.10;10.1.1.11;T1;T2;HP;A-100;Sam;2020-01-01;LaserJet;SN1;AA:BB;100;20",
        "Floor2;Floor 2;192.168.1.10;192.168.1.11;T3;T4;HP;A-200;Ann;2021-02-02;M404;SN2;CC:DD;50;10",
      ].join("\n"),
      category: "",
      tags: [],
      createdAt: "2026-10-30T10:00:00.000+04:00",
    });

    const one = await execute(deps, user, blankIntent({ intent: "search_notes", search_query: "192.168.1.10" }), { confirmed: false });
    expect(one.text).toContain("IPAddress: 192.168.1.10");
    expect(one.text).toContain("Serial number: SN2");
    expect(one.text).toContain("Source: Note #1");
    expect(one.text).not.toContain("Reception");
    expect(one.text).not.toContain("scannerIP;terminalID");
    expect(one.text).not.toContain("Color print…");

    const list = await execute(deps, user, blankIntent({ intent: "search_notes", search_query: "printer informations" }), { confirmed: false });
    expect(list.text).toContain("• Reception");
    expect(list.text).toContain("• Floor2");
    expect(list.text).not.toContain("slaveTerminalID");
    expect(list.text).not.toContain("10.1.1.10");
  });

  it("returns the matching employee row instead of full employee and PC lists", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    await db.insertNote({
      userId: user.id,
      title: "Employee name and Position",
      content: [
        "Name | Position",
        "Antje Sahling | General Manager",
        "Anggie Ambawani | Executive Secretary",
        "Rony Habib | Director of Finance & Business Support",
        "Dinesh Kumar | Network Administrator",
        "Mary Rahme | Assistant Manager",
      ].join("\n"),
      category: "",
      tags: [],
      createdAt: "2026-10-30T10:00:00.000+04:00",
    });
    await db.insertNote({
      userId: user.id,
      title: "PC user list and Extensions",
      content: "PC NAME | EXTENSION # | USER\nHADXBPLDT15KH | 6603/0 | GUEST SERVICE PC1\nHADXBPLDT15L1 | 6604/0 | GUEST SERVICE PC2",
      category: "",
      tags: [],
      createdAt: "2026-10-30T10:00:00.000+04:00",
    });
    const candidateNotes = await db.listNotes(user.id);
    deps.db.searchNotes = async () => candidateNotes;

    const reply = await execute(
      deps,
      user,
      blankIntent({ intent: "search_notes", search_query: "Dinesh" }),
      { confirmed: false },
    );

    expect(reply.text).toContain("Dinesh Kumar | Network Administrator");
    expect(reply.text).toContain("Source: Note #1");
    expect(reply.text).not.toContain("Antje Sahling");
    expect(reply.text).not.toContain("Anggie Ambawani");
    expect(reply.text).not.toContain("PC user list");
    expect(reply.text).not.toContain("HADXBPLDT15KH");
  });

  it("answers an extension question with one row from each directory shape", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    await db.insertNote({
      userId: user.id,
      title: "HR phones",
      content: "HR Specialist - 6749 (ViVi) Anggie - 6704 Faizan - 6713 Hazem - 6721 Nay - 6722",
      category: "",
      tags: [],
      createdAt: "2026-10-30T10:00:00.000+04:00",
    });
    await db.insertNote({
      userId: user.id,
      title: "PC user list",
      content: "PC NAME EXTENSION # USER HADXBPLDT15KT 6625 DUTY MANAGER - Fayaz HADXBPLNBJHFL 6722 Nay HADXBPLDT15KH 6603/0 GUEST SERVICE PC1",
      category: "",
      tags: [],
      createdAt: "2026-10-30T10:00:00.000+04:00",
    });
    await db.insertNote({
      userId: user.id,
      title: "PC directory",
      content: "PC name;Extension;User HADXBPLDT15KH;6603/0;GUEST SERVICE PC1 HADXBPLNBJHFL;6722;Nay HADXBPLDT15KT;6625;DUTY MANAGER - Fayaz",
      category: "",
      tags: [],
      createdAt: "2026-10-30T10:00:00.000+04:00",
    });

    const reply = await handleText(deps, user, "What is the extension for Nay?");
    expect(reply.text).toContain("6722");
    expect(reply.text).toContain("Nay");
    expect(reply.text).not.toContain("GUEST SERVICE");
    expect(reply.text).not.toContain("DUTY MANAGER");
    expect(reply.text).not.toContain("Faizan");
    expect(reply.text).not.toContain("PC name;Extension;User HADX");
  });

  it("returns one PC row from an extension directory", async () => {
    const { deps, db } = testDeps();
    const user = await owner(db);
    await db.insertNote({
      userId: user.id,
      title: "PC directory",
      content: ["PC name;Extension;User", "HADXBPLDT15KT;6625;DUTY MANAGER - Fayaz", "HADXBPLDT15KH;6603/0;GUEST SERVICE PC1"].join("\n"),
      category: "",
      tags: [],
      createdAt: "2026-10-30T10:00:00.000+04:00",
    });

    const reply = await execute(deps, user, blankIntent({ intent: "search_notes", search_query: "Fayaz" }), { confirmed: false });
    expect(reply.text).toContain("PC name: HADXBPLDT15KT");
    expect(reply.text).toContain("Extension: 6625");
    expect(reply.text).toContain("User: DUTY MANAGER - Fayaz");
    expect(reply.text).not.toContain("GUEST SERVICE");
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
