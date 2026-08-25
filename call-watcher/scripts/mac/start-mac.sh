#!/bin/bash
# Starts everything a Mac mini needs to record calls unattended, in the right order.
#
# Run by the Launch Agent at login (see com.fmp.callwatcher.plist), or by hand to test.
#
# Deliberately idempotent: it can be run again at any time without stopping a healthy watcher
# or opening a second Chrome. Launchd restarts this script whenever it exits, so it has to be
# safe to re-enter - and on restart it re-checks Chrome, which is what recovers the machine if
# Chrome is what died rather than the watcher.

set -u

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROFILE="$HOME/ChromeDebugProfile"
PORT=9222

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] [START-MAC] $*"; }

# ---------------------------------------------------------------- keep the machine awake
# A sleeping Mac records nothing, and a locked screen is worse: the desktop session is still
# there but a keystroke can never reach it, so the watcher keeps polling and every capture
# fails at the last step. caffeinate is held for as long as this script runs.
if ! pgrep -f "caffeinate -dimsu" > /dev/null; then
  caffeinate -dimsu &
  log "Holding the machine awake (caffeinate)."
fi

# ---------------------------------------------------------------- Chrome
# Matched on the debugging port rather than the app name: that is the only thing that
# distinguishes our instance from an ordinary Chrome the operator may have opened.
if pgrep -f -- "--remote-debugging-port=$PORT" > /dev/null; then
  log "Chrome is already running with the debugging port."
else
  log "Starting Chrome with the required flags."
  # --auto-accept-this-tab-capture is the one whose absence is SILENT: everything works right
  # up to the capture, which is then blocked by a native bubble no automation can dismiss.
  "$CHROME" \
    --remote-debugging-port="$PORT" \
    --user-data-dir="$PROFILE" \
    --auto-accept-this-tab-capture \
    > /dev/null 2>&1 &

  # Wait for the debugging port rather than guessing at a sleep: a fixed delay is either too
  # short on a cold boot or wasted time on a warm one.
  for _ in $(seq 1 30); do
    if curl -s --max-time 1 "http://localhost:$PORT/json/version" > /dev/null; then
      log "Chrome is up."
      break
    fi
    sleep 1
  done
fi

if ! curl -s --max-time 2 "http://localhost:$PORT/json/version" > /dev/null; then
  log "ERROR: Chrome did not come up on port $PORT. Not starting the watcher - it would only"
  log "       retry against a browser that is not there. Check the Chrome path in this script."
  exit 1
fi

# ---------------------------------------------------------------- the watcher
# The supervisor handles restarting the watcher itself; launchd restarts the supervisor. Two
# layers, because they cover different failures: the supervisor notices a watcher that is alive
# but blind, launchd notices the whole thing being gone.
cd "$REPO_DIR" || exit 1
log "Starting the supervisor from $REPO_DIR"
exec node scripts/supervisor.js
