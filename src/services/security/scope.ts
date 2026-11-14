/** Local scope check for /sec. Kept free of runtime dependencies so it can run before any model call. */

const OFFENSIVE =
  /\b(?:write|create|build|generate|develop|code|make|craft|give\s+me|show\s+me\s+how\s+to\s+(?:make|build|write))\b[^.\n]{0,60}\b(?:malware|ransomware|keylogger|rootkit|botnet|trojan|infostealer|credential\s+stealer|reverse\s+shell|bind\s+shell|shellcode|exploit(?:\s+code)?|payload|backdoor|cryptominer|phishing\s+(?:kit|page|site))\b/i;
const DEFENSIVE_CONTEXT = /\b(?:detect|detection|hunt|hunting|block|prevent|mitigat\w*|sigma|yara|snort|suricata|rule|ioc|indicators?|alert|siem|patch|remediat\w*)\b/i;

/** Obvious requests for offensive tooling are declined without a model call. The rules cover the rest. */
export function isOffensiveRequest(text: string): boolean {
  return OFFENSIVE.test(text) && !DEFENSIVE_CONTEXT.test(text);
}
