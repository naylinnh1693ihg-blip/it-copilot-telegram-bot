/** Sample notes for the prompt tester. They are fixtures, not saved records. */
export interface PromptCase {
  name: string;
  question: string;
  /** Null means no relevant context, so the prompt uses fallback mode. */
  context: string | null;
  sourcesLine: string;
}

export const PROMPT_CASES: PromptCase[] = [
  {
    name: "ip",
    question: "What's the IP of the floor 2 printer?",
    context: ["[1] Note #14 (narrative)", "The meeting room printer on floor 2 is an HP LaserJet at 192.168.1.10."].join("\n"),
    sourcesLine: "Sources: Note #14",
  },
  {
    name: "document",
    question: "What address does the core switch use?",
    context: ["[1] Document: Network-Map.pdf (identifier)", "Switch-Core IP: 10.0.0.1"].join("\n"),
    sourcesLine: "Sources: Document: Network-Map.pdf",
  },
  {
    name: "fallback",
    question: "Where is the spare keyboard?",
    context: null,
    sourcesLine: "",
  },
  {
    name: "mixed",
    question: "Which printer is on floor 2, and what hostname does it use?",
    context: [
      "[1] Note #14 (narrative)",
      "The meeting room on floor 2 has one printer for guests. It is not on the staff VLAN.",
      "",
      "[2] Note #14 (identifier)",
      "Floor 2 printer hostname: printer-floor2. Address: 192.168.1.10. Model: HP LaserJet M404.",
    ].join("\n"),
    sourcesLine: "Sources: Note #14",
  },
  {
    name: "howto",
    question: "How do I put a laptop on the guest network?",
    context: ["[1] Knowledge: Guest VLAN (narrative)", "Connect the laptop to the guest SSID. The guest network is VLAN 20."].join("\n"),
    sourcesLine: "Sources: Knowledge: Guest VLAN",
  },
];

export function findPromptCase(name: string): PromptCase | undefined {
  return PROMPT_CASES.find((item) => item.name === name);
}
