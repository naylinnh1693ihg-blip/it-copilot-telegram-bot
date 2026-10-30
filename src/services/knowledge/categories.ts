export const KNOWLEDGE_CATEGORIES = [
  "Network Administration",
  "Cisco Networking",
  "Switching and Routing",
  "Firewalls",
  "Wi-Fi Troubleshooting",
  "DNS and DHCP",
  "Windows Server",
  "Linux Administration",
  "Active Directory",
  "Storage Management",
  "Backup and Recovery",
  "Printer Support",
  "Hotel IT Systems",
  "Application Support",
  "Incident Management",
  "IT Security",
  "DevOps and Automation",
] as const;

const ALIASES: Array<[RegExp, (typeof KNOWLEDGE_CATEGORIES)[number]]> = [
  [/cisco|ios xe|ios\b/i, "Cisco Networking"],
  [/wi-?fi|wireless|access point|\bap\b/i, "Wi-Fi Troubleshooting"],
  [/dhcp|dns/i, "DNS and DHCP"],
  [/firewall|palo alto|fortigate/i, "Firewalls"],
  [/vlan|routing|switch/i, "Switching and Routing"],
  [/active directory|\bad\b|group policy/i, "Active Directory"],
  [/windows server/i, "Windows Server"],
  [/linux|ubuntu|debian|systemd/i, "Linux Administration"],
  [/backup|restore|veeam/i, "Backup and Recovery"],
  [/printer|print queue/i, "Printer Support"],
  [/hotel|pms|opera\b/i, "Hotel IT Systems"],
  [/incident|outage/i, "Incident Management"],
  [/security|phishing|mfa/i, "IT Security"],
  [/storage|san\b|nas\b/i, "Storage Management"],
  [/devops|ansible|script/i, "DevOps and Automation"],
];

export function matchCategory(text: string): string {
  const direct = KNOWLEDGE_CATEGORIES.find((category) => text.toLowerCase().includes(category.toLowerCase()));
  if (direct) return direct;
  for (const [pattern, category] of ALIASES) {
    if (pattern.test(text)) return category;
  }
  return "General";
}
