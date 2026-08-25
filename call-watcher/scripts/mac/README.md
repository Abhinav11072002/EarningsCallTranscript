# Running a Mac mini unattended

Setting up one machine so it records calls on its own, survives a reboot, and does not need
anybody logged in watching it.

Do this **after** `node scripts/diagnostics/diag-popup-reliability.js 5` reports 5/5 by hand.
Everything here is about keeping that working without supervision — it will not fix a machine
where the basics do not yet work.

## The rule that governs all of it

**This cannot run headless.** The capture depends on a real keystroke landing on a real window,
so the Mac needs a genuine desktop session: logged in, awake, unlocked. A locked screen is the
most likely cause of a silent, total failure — the watcher keeps polling and looks perfectly
healthy in the log, while every capture fails at the last step.

That is also why the Launch **Agent** below is not a Launch **Daemon**. Daemons run without a
desktop.

## 1. Stop the machine sleeping or locking

```bash
sudo pmset -a sleep 0 displaysleep 0 disksleep 0
defaults -currentHost write com.apple.screensaver idleTime 0
defaults write com.apple.screensaver askForPassword -int 0
```

Then confirm:

```bash
pmset -g | grep -E " sleep| displaysleep"
```

Both should read `0`.

## 2. Turn on automatic login

This one cannot be scripted reliably: System Settings → **Users & Groups** → *Automatic login*
→ select the account. Without it, a reboot leaves the machine at a login screen with no desktop,
and nothing records until somebody types a password.

FileVault prevents automatic login. If it is on, either accept that a reboot needs a human, or
turn it off — a decision worth making deliberately rather than by accident.

## 3. Install the Launch Agent

```bash
cd ~/EarningsCallTranscript/call-watcher
sed "s/USERNAME/$(whoami)/g" scripts/mac/com.fmp.callwatcher.plist > ~/Library/LaunchAgents/com.fmp.callwatcher.plist
chmod +x scripts/mac/start-mac.sh
launchctl load ~/Library/LaunchAgents/com.fmp.callwatcher.plist
```

Check it took:

```bash
launchctl list | grep callwatcher
tail -f data/launchagent.log
```

You should see Chrome being started (or found already running), then the supervisor's first
lines. To stop it: `launchctl unload ~/Library/LaunchAgents/com.fmp.callwatcher.plist`.

## 4. The permission that will catch you out

Accessibility is granted to the **process that sends the keystroke**, and under launchd that is
not Terminal. Granting it to Terminal makes the diagnostic pass by hand and the Launch Agent
fail — the most confusing possible outcome, because both look like they are running the same
thing.

After loading the agent, watch `data/launchagent.log` through a real call, or force the issue:

```bash
launchctl kickstart -k gui/$(id -u)/com.fmp.callwatcher
```

If captures fail with **exit code 3**, the injector is saying it lacks Accessibility. Add the
Node binary itself in System Settings → Privacy & Security → **Accessibility** → **+** — press
`Cmd+Shift+G` in the file picker and enter the path from `which node`.

## 5. Prove it survives a reboot

The only test that counts:

```bash
sudo reboot
```

Then, without logging in manually or opening a terminal, come back and check from another
machine — or after reconnecting — that:

```bash
curl -s http://localhost:9222/json/version     # Chrome came back with its flags
tail -20 data/launchagent.log                  # the agent started it
npm run report                                 # the day's coverage
```

If Chrome is up and the watcher is polling with nobody having touched the machine, it is done.

## What the layers do

Three, because each catches a failure the others cannot:

| Layer | Restarts | Catches |
|---|---|---|
| `launchd` (KeepAlive) | the whole script | the supervisor being gone, and reboots |
| `scripts/supervisor.js` | the watcher | it exiting, or running but blind |
| the watcher's own retries | one call | a single call failing |

`start-mac.sh` is deliberately safe to re-run: launchd relaunches it whenever it exits, and on
each pass it re-checks Chrome — which is what recovers the machine when Chrome is the thing
that died rather than the watcher.

## Screen Sharing

Connecting and disconnecting is safe. Unlike Windows Remote Desktop, disconnecting from a Mac
over Screen Sharing leaves the desktop session running rather than locking it, so you can check
on a machine mid-session and leave without stopping the work.
