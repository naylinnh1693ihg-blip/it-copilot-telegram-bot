import { CHANGE_SAFETY, TEMPLATE_SECTIONS, isAuthoritativeUrl, type TemplateSection } from "./rules.js";

/**
 * Parses and checks what the model returned for /sec. The server, not the model,
 * decides whether an answer is complete and sourced well enough to send.
 */

export interface Citation {
  number: number;
  url: string;
}

export type ParsedSecurityReply =
  | { kind: "need_details"; questions: string[] }
  | { kind: "out_of_scope"; reason: string }
  | { kind: "answer"; sections: Map<TemplateSection, string>; citations: Citation[] };

const HEADING = new RegExp(
  `^\\s*(?:#{1,6}\\s*)?(?:\\*\\*|__)?\\s*(${TEMPLATE_SECTIONS.map((name) => name.replace(/ /g, "\\s+")).join("|")}|Sources?|Change\\s+safety)\\s*(?:\\*\\*|__)?\\s*:\\s*(?:\\*\\*|__)?\\s*(.*)$`,
  "i",
);
const CITATION = /\[\[?(\d+)\]?\]\((https?:\/\/[^)\s]+)\)/g;
// Private addresses that are not in the request or inventory mean the model invented a site detail.
const PRIVATE_IP = /\b(?:192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g;

function canonicalSection(raw: string): TemplateSection | "ignored" {
  const name = raw.replace(/\s+/g, " ").trim().toLowerCase();
  const match = TEMPLATE_SECTIONS.find((section) => section.toLowerCase() === name);
  return match ?? "ignored";
}

export function parseSecurityReply(raw: string): ParsedSecurityReply {
  const text = raw.replace(/\r\n/g, "\n").trim();
  // "**NEED_DETAILS**", "Need details", and "__OUT_OF_SCOPE__" all count.
  const firstLine = (text.split("\n", 1)[0] ?? "")
    .replace(/[*#`]/g, "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (firstLine.startsWith("NEED_DETAILS")) {
    const questions = text
      .split("\n")
      .slice(1)
      .map((line) => line.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, "").trim())
      .filter(Boolean)
      .slice(0, 3);
    return { kind: "need_details", questions };
  }
  if (firstLine.startsWith("OUT_OF_SCOPE")) {
    const reason = text.split("\n").slice(1).join("\n").trim();
    return { kind: "out_of_scope", reason };
  }

  // Renumber citations by first appearance so [1], [2], ... match the Sources list.
  const order = new Map<string, number>();
  const body = text.replace(CITATION, (_match, _n: string, url: string) => {
    const clean = url.replace(/[.,;]+$/, "");
    if (!order.has(clean)) order.set(clean, order.size + 1);
    return `[${order.get(clean)}]`;
  });
  const citations = [...order.entries()].map(([url, number]) => ({ number, url }));

  const sections = new Map<TemplateSection, string>();
  let current: TemplateSection | "ignored" | null = null;
  const buffer = new Map<TemplateSection, string[]>();
  for (const line of body.split("\n")) {
    const heading = line.match(HEADING);
    if (heading?.[1]) {
      current = canonicalSection(heading[1]);
      if (current !== "ignored") {
        const lines = buffer.get(current) ?? [];
        if (heading[2]?.trim()) lines.push(heading[2].trim());
        buffer.set(current, lines);
      }
      continue;
    }
    if (current && current !== "ignored") buffer.get(current)?.push(line);
  }
  for (const section of TEMPLATE_SECTIONS) {
    const content = buffer.get(section);
    if (content) sections.set(section, content.join("\n").replace(/\n{3,}/g, "\n\n").trim());
  }
  return { kind: "answer", sections, citations };
}

/** Problems that block sending. Empty means the answer may go to the user. */
export function validateSecurityAnswer(
  reply: Extract<ParsedSecurityReply, { kind: "answer" }>,
  knownText: string,
): string[] {
  const problems: string[] = [];
  const missing = TEMPLATE_SECTIONS.filter((section) => !reply.sections.get(section)?.trim());
  if (missing.length > 0) problems.push(`missing or empty sections: ${missing.join(", ")}`);

  if (reply.citations.length === 0) {
    problems.push("no inline citations; every claim needs an authoritative source as [[n]](URL)");
  }
  const weak = reply.citations.filter((citation) => !isAuthoritativeUrl(citation.url));
  if (weak.length > 0) {
    const hosts = [...new Set(weak.map((citation) => hostOf(citation.url)))];
    problems.push(`non-authoritative sources used: ${hosts.join(", ")}`);
  }

  const allText = [...reply.sections.values()].join("\n");
  const invented = [...new Set(allText.match(PRIVATE_IP) ?? [])].filter((ip) => !knownText.includes(ip));
  if (invented.length > 0) problems.push(`addresses not in the request or inventory: ${invented.join(", ")}`);
  return problems;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url.slice(0, 60);
  }
}

export function formatSecurityAnswer(
  reply: Extract<ParsedSecurityReply, { kind: "answer" }>,
  notice: string,
): string {
  const parts: string[] = ["Security review"];
  if (notice) parts.push(notice);
  for (const section of TEMPLATE_SECTIONS) {
    parts.push(`${section}:\n${reply.sections.get(section) ?? "Not verified."}`);
  }
  parts.push(CHANGE_SAFETY);
  parts.push(`Sources:\n${reply.citations.map((citation) => `[${citation.number}] ${citation.url}`).join("\n")}`);
  return parts.join("\n\n");
}

export function formatNeedDetails(questions: string[], notice: string): string {
  const list = questions.length > 0 ? questions : ["Which vendor, model, and exact software version is this about?"];
  return [
    "Security review: I need more detail before I can give an exact answer.",
    ...(notice ? [notice] : []),
    list.map((question, index) => `${index + 1}. ${question}`).join("\n"),
    "Send /sec again with these details.",
  ].join("\n\n");
}

export function formatOutOfScope(reason: string): string {
  return [
    "Security review: out of scope.",
    reason ||
      "I only help defend systems you administer. I can help with detection, hardening, patching, or incident response instead.",
  ].join("\n\n");
}
