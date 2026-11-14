#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ ! -f "$ROOT/.env" || ! -f "$ROOT/.env.monitoring" || ! -f "$HOME/.config/rclone/rclone.conf" ]]; then
  echo "Create .env, .env.monitoring, and the rclone config before installing the schedule." >&2
  exit 1
fi

LABEL="com.itworkcopilot.weekly-backup"
AGENT_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs"
PLIST="$AGENT_DIR/$LABEL.plist"
UID_VALUE="$(id -u)"

mkdir -p "$AGENT_DIR" "$LOG_DIR"
ROOT="$ROOT" PLIST="$PLIST" LOG_DIR="$LOG_DIR" LABEL="$LABEL" node --input-type=module <<'NODE'
import { writeFile } from "node:fs/promises";

const xml = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const root = xml(process.env.ROOT);
const log = xml(process.env.LOG_DIR);
const script = `${root}/scripts/run-scheduled-backup.sh`;
const label = xml(process.env.LABEL);
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>${xml(script)}</string></array>
  <key>WorkingDirectory</key><string>${root}</string>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>${log}/${label}.log</string>
  <key>StandardErrorPath</key><string>${log}/${label}.log</string>
</dict>
</plist>
`;
await writeFile(process.env.PLIST, plist, { mode: 0o600 });
NODE

if launchctl print "gui/$UID_VALUE/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "gui/$UID_VALUE" "$PLIST"
fi
launchctl bootstrap "gui/$UID_VALUE" "$PLIST"
echo "Daily retention check installed for 03:00; backups run on Sundays."
