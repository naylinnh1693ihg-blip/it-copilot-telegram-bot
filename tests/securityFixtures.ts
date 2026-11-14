/** A well-formed /sec answer shared by the security tests. */
export const NVD = "https://nvd.nist.gov/vuln/detail/CVE-2023-20198";
export const CISCO = "https://sec.cloudapps.cisco.com/security/center/content/CiscoSecurityAdvisory/cisco-sa-iosxe-webui-privesc-j22SaA4z";

export function validAnswer(extra = ""): string {
  return [
    "Finding: The IOS XE web UI allows privilege escalation (CVE-2023-20198) [[1]](" + NVD + ").",
    "Severity: CVSS 3.1 base 10.0, AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H (NVD) [[1]](" + NVD + "). Listed in CISA KEV.",
    "Affected assets: #1 Main switch (10.0.0.2): Affected. IOS XE 17.9.4 is before the fixed 17.9.4a [[2]](" + CISCO + ").",
    "Evidence: The inventory records firmware 17.9.4 for the Main switch.",
    "Fix: On IOS XE 17.9.x, disable the HTTP server until you upgrade:",
    "no ip http server",
    "no ip http secure-server",
    "Impact: the web UI stops. No reload.",
    "Rollback: ip http server and ip http secure-server",
    "How to verify: show running-config | include ip http shows no enabled http server lines.",
    extra,
  ].join("\n");
}
