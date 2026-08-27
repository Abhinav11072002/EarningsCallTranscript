# Setting up a Mac mini from scratch

Everything needed to take a bare machine to a watcher that records calls unattended and
survives a reboot. Roughly an hour, most of it waiting for downloads.

Written from doing it once, so every step that went wrong the first time is called out here
rather than left to be rediscovered. Follow it in order — several steps depend on earlier ones
in ways that are not obvious.

> ## ⚠️ STOP — read this before setting up a SECOND machine
>
> There is no work-splitting yet. Every watcher reads the whole table and decides for itself
> what to record, keeping its own local record of what it has claimed. **Two machines running
> as-is will both record every call** — duplicate transcripts, and two browsers competing for
> the same webcast.
>
> Machine 1 is safe. Do not start machine 2 until the shard filter exists.

---

## 1. Command line tools

```bash
xcode-select --install
```

Click Install in the dialog and wait. This provides `git`. Skip if `git --version` already
works.

## 2. Homebrew

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

It asks for your password. **At the end it prints two `echo` commands to add brew to your
PATH — run those**, then confirm:

```bash
brew --version
```

## 3. Node 22 or newer

```bash
brew install node@22
echo 'export PATH="/opt/homebrew/opt/node@22/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
node -v
```

Must print **v22** or higher. The watcher refuses to start below that — it drives the extension
popup over a WebSocket that older versions do not expose.

## 4. GitHub access

The repository is private, and **GitHub removed password authentication for git in 2021** — your
account password will never work, however correctly it is typed. Use an SSH key:

```bash
ssh-keygen -t ed25519 -C "macmini-NN" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
```

Copy that output, then on github.com: **Settings → SSH and GPG keys → New SSH key** → paste →
save. Give each machine its own key so one can be revoked without touching the others.

```bash
ssh -T git@github.com
```

Expect `Hi <username>! You've successfully authenticated, but GitHub does not provide shell
access.` **That message is success**, not an error.

On first connection it asks you to verify GitHub's host key. It should read:

```
SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU
```

Check it matches, then type the whole word `yes`.

## 5. Clone and test

```bash
cd ~
git clone git@github.com:Abhinav11072002/EarningsCallTranscript.git
cd EarningsCallTranscript/call-watcher
npm install
npm run test:unit
```

**Expect `106 passed, 0 failed`** (the number grows over time; zero failures is the point). This
is a real checkpoint: it proves Node, the code and the config are sound before Chrome is
involved at all.

Save yourself typing for the rest of the setup:

```bash
echo "alias cw='cd ~/EarningsCallTranscript/call-watcher'" >> ~/.zshrc && source ~/.zshrc
```

## 6. Google Chrome

Download from google.com/chrome, drag to Applications, **launch it once** so macOS clears its
"downloaded from the internet" prompt, then quit it completely (`Cmd+Q`).

## 7. Start Chrome with the required flags

All on ONE line. The quotes matter — the path contains a space:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir="$HOME/ChromeDebugProfile" --auto-accept-this-tab-capture > /dev/null 2>&1 &
```

Do not paste it as multiple lines with backslashes — a backslash must be the last character
before a newline, and on one line they become escapes that break the command.

Verify:

```bash
curl -s http://localhost:9222/json/version
```

You should get JSON with a `Browser` field.

**`--auto-accept-this-tab-capture` is the flag whose absence is silent.** Everything appears to
work right up to the capture, which is then blocked by a system bubble no automation can
dismiss. The watcher checks for it at startup and complains loudly.

## 8. Set up that Chrome profile

`--user-data-dir` creates a **brand-new, empty profile**. Your normal Chrome's extensions and
logins are not in it, so all of this is needed once, in the window that just opened:

1. **Install the extension at the same absolute path on every machine.** Chrome derives an
   unpacked extension's ID from its folder, so identical paths give identical IDs — one config
   value that works everywhere instead of seven different ones. Use something like
   `/Users/<user>/extension`.
2. `chrome://extensions` → **Developer mode** on → **Load unpacked** → select that folder.
3. **Copy the extension ID** it shows.
4. `chrome://extensions/shortcuts` → set the scope to **"In Chrome"**, not Global. The manifest
   asks for global, but Chrome's own setting overrides it, and with Global selected the
   keystroke never reaches the extension. This does not survive a reinstall.
5. Log in to the admin portal and leave it logged in.

## 9. Point the config at that extension

```bash
cw
echo '{ "extensionId": "PASTE_THE_ID_HERE" }' > config.local.json
```

This file is gitignored, so it stays machine-specific and survives every `git pull`.

## 10. Accessibility permission

macOS blocks synthetic keystrokes by default, and this is the step most likely to catch you
out. **The permission belongs to the process that sends the keystroke — under a Launch Agent
that is not Terminal.** Granting it to Terminal only makes the diagnostic pass by hand while
the agent fails, which is the most confusing possible outcome.

System Settings → Privacy & Security → **Accessibility** → **+**, and add **both**:

```
/opt/homebrew/opt/node@22/bin/node
/usr/bin/osascript
```

Finder will not browse to `/usr/bin`. Either press **Cmd+Shift+G** and paste the path — on a PC
keyboard the **Windows key is Cmd** — or type `/` to open the same prompt. Or skip the picker
and drag the file in:

```bash
open -R /usr/bin/osascript
```

Both are added because under launchd the responsible process is not obvious: the error names
`osascript`, but macOS often attributes it to whatever launchd started. Adding both settles it
without a guessing loop.

Granting `/usr/bin/osascript` lets any AppleScript on this machine send keystrokes. On a
dedicated recording server that is a reasonable trade.

The error, if it is missing:

```
System Events got an error: osascript is not allowed to send keystrokes. (1002)
```

## 11. Prove the trigger works

```bash
cw && node scripts/diagnostics/diag-popup-reliability.js 5
```

This drives the real injector five times and reports the success rate. It deliberately stops
before Start, so it records nothing and posts nothing to the backend.

**Expect 5/5**, around 700ms each. If you get exit code 3, Accessibility is missing for whatever
you ran it from.

## 12. Stop the machine sleeping or locking

```bash
sudo pmset -a sleep 0 displaysleep 0 disksleep 0
defaults -currentHost write com.apple.screensaver idleTime 0
defaults write com.apple.screensaver askForPassword -int 0
```

Confirm both read `0`:

```bash
pmset -g | grep -E " sleep| displaysleep"
```

**A locked screen stops everything.** The capture needs a keystroke to land on a real window, so
a locked machine keeps polling, looks perfectly healthy in the log, and fails every call at the
last step.

## 13. Automatic login

System Settings → **Users & Groups** → *Automatic login* → select the account. Cannot be
scripted reliably.

Without it, a reboot leaves the machine at a login screen with no desktop, and nothing records
until somebody types a password. **FileVault prevents automatic login** — if it is on, either
accept that reboots need a human, or turn it off deliberately.

## 14. Install the Launch Agent

```bash
cw
mkdir -p ~/Library/LaunchAgents
sed "s/USERNAME/$(whoami)/g" scripts/mac/com.fmp.callwatcher.plist > ~/Library/LaunchAgents/com.fmp.callwatcher.plist
```

Check the substitution worked — if this still says `USERNAME`, everything after it fails
confusingly:

```bash
grep start-mac ~/Library/LaunchAgents/com.fmp.callwatcher.plist
```

Check that launchd will be able to find Node. It gets a minimal PATH without Homebrew, which is
the most common reason an agent fails while the same script runs fine by hand:

```bash
which node
grep -A1 '<key>PATH</key>' ~/Library/LaunchAgents/com.fmp.callwatcher.plist
```

The directory holding `node` must appear in that string. Then load it:

```bash
launchctl load ~/Library/LaunchAgents/com.fmp.callwatcher.plist
sleep 5 && tail -20 data/launchagent.log
```

You should see caffeinate, Chrome found or started, the supervisor, and `Poll #1` with real row
counts. **No `chmod` step** — the script is committed executable, and running `chmod` on it
would leave a permanent local modification that makes every later `git pull` refuse to update
that one file.

## 15. Verify under launchd, not under Terminal

A diagnostic run from a terminal proves nothing about the agent — different permissions. Run it
as a launchd job, and remove it in the same command, because a submitted job restarts when it
exits:

```bash
launchctl submit -l cw-diag -o /tmp/cw-diag.log -e /tmp/cw-diag.log -- /opt/homebrew/opt/node@22/bin/node "$HOME/EarningsCallTranscript/call-watcher/scripts/diagnostics/diag-popup-reliability.js" 3
sleep 10 && launchctl remove cw-diag && cat /tmp/cw-diag.log
```

**Expect 3/3.** Anything else is worth fixing before trusting the machine.

## 16. The only test that counts

```bash
sudo reboot
```

Afterwards, **without logging in manually or opening anything**:

```bash
tail -20 ~/EarningsCallTranscript/call-watcher/data/launchagent.log
curl -s http://localhost:9222/json/version
```

If Chrome is back with its flags and the watcher is polling with nobody having touched the
machine, the setup is done.

---

## Running it day to day

```bash
cw && npm run report      # did we get everything today?
cat data/heartbeat.json   # live state, rewritten every 20 seconds
tail -f data/launchagent.log
npm run stop              # stop the watcher (use launchctl unload to keep it stopped)
```

**`unaccounted` must always be 0.** It means a call entered the window with a usable link and
left no trace — the only failure the system cannot otherwise see. Everything else is named and
countable.

To update a machine:

```bash
cw && git pull
launchctl kickstart -k gui/$(id -u)/com.fmp.callwatcher
tail -5 data/call-watcher-$(date +%F).log
```

**The restart is not optional.** `git pull` changes the files on disk; the running process keeps
the code it loaded at launch. `RunAtLoad` and `KeepAlive` mean the watcher starts itself and
stays up — which is exactly why a pull on its own looks like it worked and changes nothing. The
`tail` is the check: a fresh `Watching table every 20000ms` line with a current timestamp.

Time the restart for a moment with nothing in the 15-minute window. A restart mid-capture is
survivable — started calls are reconciled against the extension's stream list — but there is no
reason to rely on that.

**Read what `git pull` actually said.** These two lines mean the update did NOT arrive:

```
   295537a..750638e  main -> origin/main
Already up to date.
```

It fetched the commits, and then the checked-out branch had nothing to fast-forward — i.e. the
machine is not on `main`. `git branch --show-current` says which branch it is on; `git checkout
main` fixes it. A successful pull says `295537a..750638e  main -> main`, with no arrow to
`origin/`.

## When something is wrong

| Symptom | Cause |
|---|---|
| `osascript is not allowed to send keystrokes (1002)` | Accessibility missing — step 10 |
| Popup never opens, no error | Shortcut scope set to Global instead of "In Chrome" |
| Capture blocked by a system bubble | Chrome launched without `--auto-accept-this-tab-capture` |
| `ZERO rows on 3 consecutive polls` | Portal session expired — needs a human to log in again |
| Agent fails but the script works by hand | launchd's PATH — step 14 |
| `git pull` refuses to update one file | A local `chmod` — `git checkout -- <file>` then pull |
| Everything healthy, nothing recorded | Check the screen is not locked |
| `npm error ... package.json` | You are in the repo root, not `call-watcher` — use `cw` |
