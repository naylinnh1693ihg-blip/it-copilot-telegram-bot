import { redactString } from "../../utils/text.js";

/**
 * Removes secrets from pasted configurations, logs, and emails before anything reaches xAI.
 * IP addresses, hostnames, and email headers are kept because the analysis needs them.
 */

export interface Redaction {
  text: string;
  /** One label per removed value, e.g. "SNMP community". Never the value itself. */
  removed: string[];
}

interface Rule {
  label: string;
  pattern: RegExp;
  /** Keeps capture group 1 (the setting name) and replaces the value. Absent: the whole match is replaced. */
  keepPrefix?: boolean;
  replacement?: string;
  /** Return true to leave a match alone, e.g. "password is required". */
  skip?: (match: string) => boolean;
}

const COMMON_WORDS = new Set(["required", "missing", "wrong", "incorrect", "expired", "invalid", "weak", "strong", "empty", "set", "changed", "correct", "needed"]);

const PLACEHOLDER = "[REDACTED]";

const RULES: Rule[] = [
  {
    label: "private key",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED private key]",
  },
  // Cisco IOS, IOS XE, NX-OS, and ASA
  { label: "enable secret", pattern: /^(\s*enable\s+(?:secret|password)(?:\s+level\s+\d+)?(?:\s+\d{1,2})?\s+)\S+/gim, keepPrefix: true },
  { label: "user password", pattern: /^(\s*username\s+\S+.*?\b(?:secret|password)(?:\s+\d{1,2})?\s+)\S+/gim, keepPrefix: true },
  { label: "SNMP community", pattern: /^(\s*snmp-server\s+community\s+)\S+/gim, keepPrefix: true },
  { label: "SNMPv3 key", pattern: /(\b(?:auth\s+(?:md5|sha\S*)|priv\s+(?:des\S*|3des|aes(?:\s+\d+)?))\s+)\S+/gi, keepPrefix: true },
  { label: "key string", pattern: /^(\s*key-string(?:\s+\d)?\s+)\S+/gim, keepPrefix: true },
  {
    label: "AAA server key",
    pattern: /^(\s*(?:tacacs-server|radius-server)\s+(?:host\s+\S+\s+)?key(?:\s+\d)?\s+)\S+/gim,
    keepPrefix: true,
  },
  { label: "AAA server key", pattern: /^(\s*(?:server-)?key\s+[0-7]\s+)\S+/gim, keepPrefix: true },
  { label: "IKE pre-shared key", pattern: /^(\s*crypto\s+isakmp\s+key(?:\s+\d)?\s+)\S+/gim, keepPrefix: true },
  {
    label: "pre-shared key",
    pattern: /(\bpre-shared-key\s+(?:local\s+|remote\s+)?(?:address\s+\S+\s+)?(?:key\s+)?(?:ascii-text\s+)?(?:\d\s+)?)"?[^\s";]+"?/gi,
    keepPrefix: true,
  },
  { label: "Wi-Fi passphrase", pattern: /(\bwpa-psk\s+(?:ascii|hex)\s+(?:\d\s+)?)\S+/gi, keepPrefix: true },
  // FortiOS
  {
    label: "FortiOS secret",
    pattern:
      /^(\s*set\s+(?:password|passwd|psksecret|secret|key|passphrase|auth-pwd|priv-pwd|community|ppk-secret|private-key|sae-password|server-secret|ldap-password|tacacs-key|radius-secret|apikey|api-key|auth-password)\s+)(?:ENC\s+)?\S+/gim,
    keepPrefix: true,
  },
  // Junos
  {
    label: "Junos secret",
    pattern: /(\b(?:encrypted-password|authentication-key|ascii-text|secret)\s+)"[^"\n]*"/gi,
    keepPrefix: true,
  },
  // PAN-OS and other XML exports
  {
    label: "XML secret",
    pattern: /(<(phash|password|key|secret|psk|community|private-key)>)[^<]+(?=<\/\2>)/gi,
    keepPrefix: true,
  },
  // Password hashes: crypt formats, Cisco type 5/8/9
  { label: "password hash", pattern: /\$(?:1|2[aby]?|5|6|7|8|9|y|sha1|apr1)\$[^\s:'"]+/g },
  // Credentials inside URLs
  { label: "URL credential", pattern: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+(?=@)/gi, keepPrefix: true },
  // Cloud and SaaS tokens
  { label: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { label: "Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { label: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // Generic key = value and "password is ..."
  {
    label: "credential",
    pattern:
      /(\b(?:password|passwd|pwd|passphrase|client[_-]?secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|private[_-]?key|secret[_-]?key)\b\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
    keepPrefix: true,
  },
  {
    label: "credential",
    pattern: /(\b(?:password|passcode|api key|access token|secret)\s+is\s+)([^\s.,;]{4,})/gi,
    keepPrefix: true,
    skip: (match) => COMMON_WORDS.has(match.split(/\s+/).pop()?.toLowerCase() ?? ""),
  },
];

export function redactSecrets(input: string): Redaction {
  const removed: string[] = [];
  let text = input;
  for (const rule of RULES) {
    text = text.replace(rule.pattern, (match: string, prefix?: unknown) => {
      if (match.includes(PLACEHOLDER) && !rule.replacement) return match;
      if (rule.skip?.(match)) return match;
      removed.push(rule.label);
      if (rule.keepPrefix && typeof prefix === "string") return `${prefix}${PLACEHOLDER}`;
      return rule.replacement ?? PLACEHOLDER;
    });
  }
  // Bot tokens, xAI keys, JWTs, and Bearer headers use the app-wide redactor.
  const shared = redactString(text);
  if (shared !== text) removed.push("token");
  return { text: shared, removed };
}

/** "2 secrets (SNMP community, enable secret)". Empty string when nothing was removed. */
export function describeRedactions(removed: string[]): string {
  if (removed.length === 0) return "";
  const kinds = [...new Set(removed)];
  const noun = removed.length === 1 ? "secret" : "secrets";
  return `${removed.length} ${noun} (${kinds.join(", ")})`;
}
