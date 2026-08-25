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
# The PORT ANSWERING is the only thing that matters, so it is the only thing checked.
#
# This used to ask pgrep whether a matching process existed and trust the answer. That produced
# a script contradicting itself in the log - "Chrome is already running with the debugging
# port" immediately followed by "Chrome did not come up on port 9222" - because a Chrome that
# is shutting down still appears in the process table for a moment while no longer serving.
# A process existing was never the question.
chrome_responds() {
  curl -s --max-time 2 "http://localhost:$PORT/json/version" > /dev/null 2>&1
}

if chrome_responds; then
  log "Chrome is already up on port $PORT."
else
  # A process may still be holding the profile while it exits. Starting a second Chrome against
  # the same --user-data-dir while that is true does not give us our flags, so wait it out.
  if pgrep -f -- "--remote-debugging-port=$PORT" > /dev/null; then
    log "A Chrome process holds the port but is not answering - waiting for it to exit."
    for _ in $(seq 1 15); do
      pgrep -f -- "--remote-debugging-port=$PORT" > /dev/null || break
      sleep 1
    done
  fi

  log "Starting Chrome with the required flags."
  # Launched with `open` rather than as a child of this script. As a child it shared this job's
  # process group, so restarting the Launch Agent killed Chrome too - taking every in-flight
  # capture with it. Detached, Chrome survives a watcher or supervisor restart, which is the
  # behaviour that protects a recording in progress.
  #
  # --auto-accept-this-tab-capture is the flag whose absence is SILENT: everything works right
  # up to the capture, which is then blocked by a native bubble no automation can dismiss.
  open -na "Google Chrome" --args \
    --remote-debugging-port="$PORT" \
    --user-data-dir="$PROFILE" \
    --auto-accept-this-tab-capture

  # Wait for the port rather than guessing at a sleep: a fixed delay is either too short on a
  # cold boot or wasted time on a warm one.
  for _ in $(seq 1 30); do
    if chrome_responds; then
      log "Chrome is up."
      break
    fi
    sleep 1
  done
fi

if ! chrome_responds; then
  log "ERROR: Chrome is not answering on port $PORT. Not starting the watcher - it would only"
  log "       retry against a browser that is not there. Check that Google Chrome is installed"
  log "       and that nothing else is holding port $PORT."
  exit 1
fi

# ---------------------------------------------------------------- the watcher
# The supervisor handles restarting the watcher itself; launchd restarts the supervisor. Two
# layers, because they cover different failures: the supervisor notices a watcher that is alive
# but blind, launchd notices the whole thing being gone.
cd "$REPO_DIR" || exit 1
log "Starting the supervisor from $REPO_DIR"
exec node scripts/supervisor.js
