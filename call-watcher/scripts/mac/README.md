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
mkdir -p ~/Library/LaunchAgents
sed "s/USERNAME/$(whoami)/g" scripts/mac/com.fmp.callwatcher.plist > ~/Library/LaunchAgents/com.fmp.callwatcher.plist
launchctl load ~/Library/LaunchAgents/com.fmp.callwatcher.plist
```

No `chmod` step: the script is committed executable. It used to need one, and that turned out
to matter - git tracks the executable bit, so running `chmod +x` on a file committed without it
leaves a permanent local modification, and every later `git pull` refuses to update that file:

```
error: Your local changes to the following files would be overwritten by merge
```

Which meant a machine silently stopped receiving fixes to the very script being fixed. If a
machine is already in that state, discard the mode change and pull again:

```bash
git checkout -- call-watcher/scripts/mac/start-mac.sh
git pull
```

Check it took:

```bash
launchctl list | grep callwatcher
tail -f data/launchagent.log
```

You should see Chrome being started (or found already running), then the supervisor's first
lines. To stop it: `launchctl unload ~/Library/LaunchAgents/com.fmp.callwatcher.plist`.

## 4. Accessibility - the step that will catch you out

Not a prediction: this happened on the first machine, and it will happen on every one.

Accessibility is granted to the **process that sends the keystroke**, and under launchd that is
not Terminal. Granting it to Terminal makes the diagnostic pass by hand and the Launch Agent
fail, which is the most confusing possible outcome because both look like they are running the
same thing. The exact error:

```
System Events got an error: osascript is not allowed to send keystrokes. (1002)
```

Add **both** of these in System Settings > Privacy & Security > **Accessibility** > **+**:

```
/opt/homebrew/opt/node@22/bin/node
/usr/bin/osascript
```

Both, because under launchd the responsible process is not obvious. The error names
`osascript`, but TCC often attributes it to whatever launchd started instead. Adding both
settles it without a guessing loop.

Note the trade: granting `/usr/bin/osascript` lets any AppleScript on the machine send
keystrokes. On a dedicated recording server that is reasonable. If you would rather not, add
`node` alone first and re-test; if that is enough, remove `osascript` again.

If the path is a Homebrew symlink, `readlink -f` gives the real one. TCC can be fussy about
symlinks, so add the resolved path too if in doubt.

### Adding a command-line binary in the file picker

Finder will not browse to `/usr/bin`. Either press **Cmd+Shift+G** and paste the path - on a PC
keyboard the **Windows key** is Cmd - or type `/` to open the same prompt. Or skip the picker
and drag the file in from Finder:

```bash
open -R /usr/bin/osascript
```

### Verify under launchd, not under Terminal

A diagnostic run from a terminal proves nothing about the agent, because they have different
permissions. Run it as a launchd job instead, and remove it in the same command - a submitted
job restarts when it exits and will otherwise loop:

```bash
launchctl submit -l cw-diag -o /tmp/cw-diag.log -e /tmp/cw-diag.log -- /opt/homebrew/opt/node@22/bin/node "$HOME/EarningsCallTranscript/call-watcher/scripts/diagnostics/diag-popup-reliability.js" 3
sleep 8 && launchctl remove cw-diag && cat /tmp/cw-diag.log
```

Anything other than 3/3 is worth fixing before trusting the machine.

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
