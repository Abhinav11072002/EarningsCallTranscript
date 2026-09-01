#!/bin/bash
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LABEL="com.fmp.calldashboard"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE="$(command -v node || true)"

if [ -z "$NODE" ]; then
  echo "node is not on PATH in this shell, so the agent would not find it either." >&2
  exit 1
fi

if [ ! -f "$REPO/scripts/dashboard.js" ]; then
  echo "Could not find scripts/dashboard.js under $REPO - run this from inside the repo." >&2
  exit 1
fi

NODE_DIR="$(dirname "$NODE")"
mkdir -p "$HOME/Library/LaunchAgents" "$REPO/data"

cat > "$PLIST" <<PLIST_END
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE</string>
        <string>$REPO/scripts/dashboard.js</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>$REPO/data/dashboard.log</string>
    <key>StandardErrorPath</key>
    <string>$REPO/data/dashboard.log</string>
    <key>WorkingDirectory</key>
    <string>$REPO</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$NODE_DIR:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
</dict>
</plist>
PLIST_END

echo "Wrote $PLIST"
echo "  node: $NODE"
echo "  repo: $REPO"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 2

echo
launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E "^\s+(state|pid) " || echo "Agent is registered but not reporting a pid yet - check data/dashboard.log"
echo
tail -5 "$REPO/data/dashboard.log" 2>/dev/null || true
