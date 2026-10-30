const COMMON_WORDS = new Set([
  "required",
  "missing",
  "unknown",
  "correct",
  "wrong",
  "empty",
  "stored",
  "saved",
  "used",
  "set",
  "needed",
  "enabled",
  "disabled",
  "changed",
  "available",
]);

export function cleanText(input: string, max: number): string {
  let result = "";
  for (const char of input) {
    const code = char.charCodeAt(0);
    const hidden = code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31);
    if (!hidden) result += char;
  }
  return result.trim().slice(0, max);
}

export function redactString(value: string): string {
  return value
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot[redacted]")
    .replace(/\b(?:xai|sk)-[A-Za-z0-9_-]{8,}/g, "[redacted-key]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}/g, "[redacted-jwt]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
}

export function secretRisk(text: string): string | null {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) return "private key";
  if (/\b(?:api[_-]?key|client[_-]?secret|access[_-]?token|password|passwd|private[_-]?key)\b\s*[:=]\s*\S+/i.test(text)) {
    return "credential";
  }
  if (/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(text)) return "token";
  if (/\b(?:xai|sk)-[A-Za-z0-9]{10,}\b/.test(text)) return "API key";
  const stated = text.match(/\b(password|passcode|api key|access token|secret)\s+is\s+([^\s.]{6,})/i);
  if (stated?.[2] && !COMMON_WORDS.has(stated[2].toLowerCase())) return "credential";
  return null;
}

const DISRUPTIVE = [
  /write\s+erase/i,
  /erase\s+startup/i,
  /\breload\b/i,
  /\bshutdown\b/i,
  /rm\s+-rf/i,
  /drop\s+database/i,
  /\bformat\s+[a-z]:/i,
  /clear\s+config/i,
  /delete\s+vlan/i,
  /no\s+interface/i,
];

export function disruptiveWarning(text: string): string | null {
  if (!DISRUPTIVE.some((pattern) => pattern.test(text))) return null;
  return "This can disrupt a live system. Confirm you are in a lab or an approved change window before you run it. I will describe the impact, and I will not walk through a production change.";
}

export function chunkText(text: string, size = 3500): string[] {
  const value = text.trim();
  if (!value) return ["I don't have anything to show for that."];
  const parts: string[] = [];
  let rest = value;
  while (rest.length > size) {
    const cut = rest.lastIndexOf("\n", size);
    const at = cut > 200 ? cut : size;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

export function parseTags(value: string): string[] {
  return value
    .split(/[,#]/)
    .map((tag) => cleanText(tag, 40))
    .filter((tag) => tag.length > 0)
    .slice(0, 10);
}

export function snippet(text: string, max = 180): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}
