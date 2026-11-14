import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { describeRedactions, redactSecrets } from "../src/services/security/redact.js";
import { formatNeedDetails, formatSecurityAnswer, parseSecurityReply, validateSecurityAnswer } from "../src/services/security/reply.js";
import { CHANGE_SAFETY, SECURITY_RULES, TEMPLATE_SECTIONS, formatRules, isAuthoritativeUrl } from "../src/services/security/rules.js";
import { isOffensiveRequest } from "../src/services/security/scope.js";
import { CISCO, NVD, validAnswer } from "./securityFixtures.js";

describe("security rules", () => {
  it("numbers twelve rules and keeps the doc in step with them", () => {
    expect(SECURITY_RULES.map((rule) => rule.id)).toEqual(SECURITY_RULES.map((_rule, index) => `R${index + 1}`));
    const doc = readFileSync(new URL("../docs/security-specialist-rules.md", import.meta.url), "utf8");
    for (const rule of SECURITY_RULES) expect(doc).toContain(`| ${rule.id} | ${rule.title} |`);
    expect(formatRules()).toContain("R3. Authoritative sources only");
  });

  it("accepts only authoritative hosts and their subdomains", () => {
    expect(isAuthoritativeUrl(NVD)).toBe(true);
    expect(isAuthoritativeUrl(CISCO)).toBe(true);
    expect(isAuthoritativeUrl("https://attack.mitre.org/techniques/T1110/")).toBe(true);
    expect(isAuthoritativeUrl("https://www.cisecurity.org/benchmark/cisco")).toBe(true);
    expect(isAuthoritativeUrl("https://msrc.microsoft.com/update-guide/vulnerability/CVE-2024-0001")).toBe(true);
    expect(isAuthoritativeUrl("https://medium.com/@someone/cve-2023-20198")).toBe(false);
    expect(isAuthoritativeUrl("https://nvd.nist.gov.evil.example/x")).toBe(false);
    expect(isAuthoritativeUrl("https://notcisco.com/advisory")).toBe(false);
    expect(isAuthoritativeUrl("javascript:alert(1)")).toBe(false);
  });

  it("declines obvious offensive tooling but not detection work", () => {
    expect(isOffensiveRequest("Write ransomware that encrypts the file server")).toBe(true);
    expect(isOffensiveRequest("give me a reverse shell payload for Windows")).toBe(true);
    expect(isOffensiveRequest("Create a Sigma rule to detect a reverse shell")).toBe(false);
    expect(isOffensiveRequest("Is CVE-2023-20198 being exploited in the wild?")).toBe(false);
    expect(isOffensiveRequest("Check this email for phishing")).toBe(false);
  });
});

describe("secret redaction", () => {
  it("removes Cisco secrets but keeps addresses and structure", () => {
    const config = [
      "hostname CORE-SW1",
      "enable secret 9 $9$abcDEFghiJKL$mnopQRSTuvwxYZ0123456789abcdefghijklmn",
      "username admin privilege 15 secret 5 $1$mERr$hx5rVt7rPNoS4wqbXKX7m0",
      "username backup password 7 0822455D0A16",
      "snmp-server community Publ1cR3ad RO",
      "tacacs-server host 10.0.0.9 key 7 1511021F0725",
      "crypto isakmp key Sup3rPSK address 203.0.113.7",
      "interface Vlan10",
      " ip address 10.0.0.2 255.255.255.0",
    ].join("\n");
    const result = redactSecrets(config);
    for (const secret of ["$9$abcDEF", "$1$mERr", "0822455D0A16", "Publ1cR3ad", "1511021F0725", "Sup3rPSK"]) {
      expect(result.text).not.toContain(secret);
    }
    expect(result.text).toContain("snmp-server community [REDACTED] RO");
    expect(result.text).toContain("ip address 10.0.0.2 255.255.255.0");
    expect(result.text).toContain("hostname CORE-SW1");
    expect(result.removed).toContain("SNMP community");
    expect(result.removed).toHaveLength(6);
  });

  it("removes FortiOS, Junos, XML, key files, tokens, and URL credentials", () => {
    const text = [
      "set password ENC SH2nlSm9QL9tapcHPXIqAXvX7vBJuuqu22hpa0JX0sBuKIo7z2g0Kz/+0KyH4E=",
      "set psksecret ENC r4nd0mValue==",
      'set encrypted-password "$6$salt$hashedvalue"',
      'authentication-key "$9$abcd1234"',
      "<phash>$1$abcd$efghijkl</phash>",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
      "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
      "aws key AKIAIOSFODNN7EXAMPLE",
      "backup url https://svc:Hunter22@files.example.com/share",
      "api_key=abc123def456",
      "The wifi password is Coffee2026",
    ].join("\n");
    const result = redactSecrets(text);
    for (const secret of ["SH2nlSm9", "r4nd0mValue", "hashedvalue", "abcd1234", "efghijkl", "MIIEpAIBAAKCAQEA", "dozjgNryP4J3", "AKIAIOSFODNN7EXAMPLE", "Hunter22", "abc123def456", "Coffee2026"]) {
      expect(result.text).not.toContain(secret);
    }
    expect(result.text).toContain("https://svc:[REDACTED]@files.example.com/share");
    expect(result.text).toContain("[REDACTED private key]");
    expect(describeRedactions(result.removed)).toMatch(/^\d+ secrets \(/);
  });

  it("leaves ordinary prose and logs alone", () => {
    const text = "Failed password for invalid user admin from 198.51.100.4 port 52211 ssh2\nThe password is required for sign-in.";
    const result = redactSecrets(text);
    expect(result.text).toBe(text);
    expect(result.removed).toEqual([]);
    expect(describeRedactions([])).toBe("");
  });
});

describe("security reply checks", () => {
  it("parses the seven sections and renumbers citations into one Sources list", () => {
    const parsed = parseSecurityReply(validAnswer());
    expect(parsed.kind).toBe("answer");
    if (parsed.kind !== "answer") return;
    expect([...parsed.sections.keys()]).toEqual([...TEMPLATE_SECTIONS]);
    expect(parsed.citations).toEqual([
      { number: 1, url: NVD },
      { number: 2, url: CISCO },
    ]);
    expect(parsed.sections.get("Fix")).toContain("no ip http server");
    expect(validateSecurityAnswer(parsed, "Main switch 10.0.0.2 firmware 17.9.4")).toEqual([]);

    const text = formatSecurityAnswer(parsed, "Removed before analysis: 1 secret (SNMP community). Nothing from /sec is saved.");
    expect(text.indexOf("Finding:")).toBeLessThan(text.indexOf("Severity:"));
    expect(text.indexOf("Rollback:")).toBeLessThan(text.indexOf("How to verify:"));
    expect(text).toContain(CHANGE_SAFETY);
    expect(text).toContain(`Sources:\n[1] ${NVD}\n[2] ${CISCO}`);
    expect(text).toContain("CVE-2023-20198) [1].");
    expect(text).not.toContain("[[");
  });

  it("accepts markdown headings and a model-written Sources section without trusting it", () => {
    const parsed = parseSecurityReply(
      validAnswer("Sources:\n[1] https://blog.example.com/not-used").replace("Finding:", "## **Finding:**").replace("Severity:", "**Severity:**"),
    );
    if (parsed.kind !== "answer") throw new Error("expected answer");
    expect(parsed.sections.get("Finding")).toContain("privilege escalation");
    expect(parsed.sections.get("How to verify")).not.toContain("blog.example.com");
    expect(validateSecurityAnswer(parsed, "10.0.0.2")).toEqual([]);
  });

  it("rejects missing sections, missing citations, weak sources, and invented addresses", () => {
    const missing = parseSecurityReply("Finding: Something [[1]](" + NVD + ")\nSeverity: High");
    if (missing.kind !== "answer") throw new Error("expected answer");
    expect(validateSecurityAnswer(missing, "")[0]).toContain("Affected assets, Evidence, Fix, Rollback, How to verify");

    const uncited = parseSecurityReply(validAnswer().replace(/\[\[\d\]\]\([^)]+\)/g, ""));
    if (uncited.kind !== "answer") throw new Error("expected answer");
    expect(validateSecurityAnswer(uncited, "10.0.0.2").join(" ")).toContain("no inline citations");

    const weak = parseSecurityReply(validAnswer("Evidence note [[3]](https://www.reddit.com/r/networking/x)"));
    if (weak.kind !== "answer") throw new Error("expected answer");
    expect(validateSecurityAnswer(weak, "10.0.0.2").join(" ")).toContain("non-authoritative sources used: www.reddit.com");

    const invented = parseSecurityReply(validAnswer("Also check the gateway at 192.168.50.1."));
    if (invented.kind !== "answer") throw new Error("expected answer");
    expect(validateSecurityAnswer(invented, "10.0.0.2").join(" ")).toContain("192.168.50.1");
    expect(validateSecurityAnswer(invented, "gateway 192.168.50.1")).toEqual([]);
  });

  it("reads NEED_DETAILS and OUT_OF_SCOPE replies", () => {
    const need = parseSecurityReply("NEED_DETAILS\n1. Which FortiOS version is the firewall running?\n2. Is the SSL-VPN enabled?");
    expect(need).toEqual({
      kind: "need_details",
      questions: ["Which FortiOS version is the firewall running?", "Is the SSL-VPN enabled?"],
    });
    if (need.kind === "need_details") {
      const text = formatNeedDetails(need.questions, "");
      expect(text).toContain("1. Which FortiOS version");
      expect(text).toContain("Send /sec again");
    }
    expect(parseSecurityReply("**OUT_OF_SCOPE**\nI can't write exploit code. I can help you patch it.")).toEqual({
      kind: "out_of_scope",
      reason: "I can't write exploit code. I can help you patch it.",
    });
  });
});
