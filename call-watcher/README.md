# call-watcher

Watches the admin portal's "In Call View" (Upcoming) table. For every call starting within
`thresholdMinutes` (default 15) it opens the dial-in link, resolves the real webcast link if
needed, handles the registration gate (fills identity fields, or clicks through an
account-based flow like Q4 Inc.'s events platform), joins the call, and triggers the pinned
"FMP transcripts" Chrome extension to start transcription with the right Symbol/Year/Period.

Requires **Node 22+** (checked at startup): the extension popup is driven over a raw CDP
WebSocket using the global `WebSocket` class, which older runtimes do not expose. On an older
Node everything up to the final step works and then every call fails, so the check is explicit
rather than left to `engines`.

The sections below capture the non-obvious mechanics - most of them exist because of a real
Chrome/Windows behaviour found by live testing, not by design. Where a comment or section says
"verified", it was reproduced directly against the live browser.

## How the extension gets triggered (the tricky part)

Opening the extension's popup and filling it turned out to need four non-obvious pieces,
each found by testing against the real thing rather than assumed up front:

1. **A real OS-level keypress, via `SendInput`, not `SendKeys`.** The extension's capture
   (`getDisplayMedia` in `content-script.js`) relies on Chrome's `activeTab` grant, which only
   follows a genuine user gesture invoking the extension. `System.Windows.Forms.SendKeys`
   reliably achieves real OS focus on the target window, but Chrome's command shortcut still
   never fired from it - a real physical keypress on the same focused window worked fine. That
   means `SendKeys` delivers keystrokes by posting window messages rather than true low-level
   input, and Chrome's command layer doesn't treat that as a genuine keypress. `SendInput`
   (`scripts/send-shortcut.ps1`) injects synthetic input at the same level as real hardware,
   which Chrome's command shortcuts do respond to.
2. **Taking the foreground is the least reliable step, and needed real work.** Measured with a
   dedicated harness (`node scripts/diagnostics/diag-popup-reliability.js 30`, which opens and fills the
   popup 30 times without starting recordings): the first version scored **0/30** whenever any
   non-Chrome window held the foreground, because Windows silently refuses
   `SetForegroundWindow` from a process that does not already own it - it just returns false.
   An earlier 11/12 reading was misleading: it only passed because Chrome happened to be the
   active window already. Two changes took it to **30/30** (median 1.3s): a benign ALT tap
   before each attempt (Windows treats a process that just received keyboard input as eligible
   to set the foreground), and a retry loop, since focus can be stolen back in the moment after
   a successful call. The script now also exits non-zero rather than injecting keystrokes it
   knows will land on the wrong window.

3. **Finding the right OS window isn't just "Chrome's main window."** A `chrome.exe` process
   can own more than one top-level window (e.g. a webcast link that opens its player in a
   separate popup window, not just a new tab) - `Process.MainWindowHandle` only ever reports
   one of them, ambiguously. `send-shortcut.ps1` enumerates every visible top-level window
   across every `chrome.exe` process matching `--remote-debugging-port`, and picks the one
   whose title matches the actual target tab (passed in from `extensionTrigger.js` via
   `targetPage.title()`), falling back to `MainWindowHandle` if no title matches.
4. **Playwright never sees the popup as a page.** Confirmed directly with
   `scripts/diagnostics/diag-popup.js`: the popup opens visibly and is listed by Chrome's own
   `/json/list` HTTP endpoint, but `context.pages()` / the `'page'` event never see it -
   Playwright's auto-attach doesn't reach it, most likely because it isn't spawned as a child
   of any target Playwright already tracks. So `extensionTrigger.js` finds it via that same
   `/json/list` endpoint and drives it through a **raw CDP WebSocket connection**
   (`Runtime.evaluate`) instead of Playwright's `Page` API. Setting `.value` and calling
   `.click()` this way is fine - only the earlier `getDisplayMedia` call needed a trusted
   gesture, and that was already satisfied by the real `SendInput` keypress that opened the
   popup in the first place.

The extension itself needed two small changes (already applied if you're reading this after
initial setup): `manifest.json` gained a `background` service worker and a `commands` entry
(a keyboard shortcut, scope must be **"In Chrome"** - `"global": true` shortcuts didn't fire
reliably in testing) that calls `chrome.action.openPopup()`; `popup.html`'s `#symbol` input
got an `autofocus` attribute.

**Confirming success per call matters.** `activeStreams` persists in `chrome.storage.local`
across popup open/close cycles, so a naive "does any `.stream-item` exist" check false-positives
on a *previous* call's still-active stream the instant a new popup opens - before this row's own
click handler (which has a 300ms debounce plus a network fetch for the Deepgram key) has done
anything. `extensionTrigger.js` waits specifically for a stream-item matching *this* row's
`symbol - year period` label, which also guarantees the pipeline doesn't advance to the next
call (and switch the active tab) until this one has genuinely started.

## Truncated dial-in links

The portal's frontend truncates long dial-in links for display - a real truncated string with
a literal `"..."` baked into the actual `textContent`, confirmed by reading the raw DOM (not a
CSS ellipsis, which wouldn't affect `textContent` at all). An API-based route to the full link
was investigated and abandoned: the portal's own request to fetch this data carries a bearer
token that lives only in the React app's in-memory state (not localStorage, sessionStorage,
cookies, or IndexedDB), so it can't be reproduced from outside the page's own running JS
without reverse-engineering intentionally-unexposed internals - fragile and not worth it.

Instead, `dialinLinkClickResolver.js` clicks the cell directly on the live portal page: the
React click handler evidently has the full URL in its own component state regardless of what's
visibly truncated, and clicking it opens a new tab to the correct destination (confirmed live -
clicking a truncated link manually and via this resolver both produced the identical full URL).
Playwright's `element.click()` is required rather than a JS-triggered `el.click()` inside
`page.evaluate()` - a synthetic click is often not trusted enough to get the resulting
`window.open()` past Chrome's popup blocker, the same "needs a real gesture" pattern already
seen with the extension's `getDisplayMedia()` call. The resolved URL is fed into the normal
`resolveWebcastPage()` pipeline exactly as if it had been a normal, untruncated link all along -
`index.js` only reaches for this when a row's `dialinLink` ends in `"..."`.

## Running indefinitely

Three things had to change for `npm start` to be left running for weeks rather than an
afternoon. Each was a real leak, not a theoretical one.

**Call tabs are closed when their call ends.** The pipeline deliberately does not close a tab on
success - the capture lives in it. But nothing closed them afterwards either, so every call left
a tab holding a `MediaRecorder` and a websocket. `callTabs.js` closes a tab once its call is
marked complete, with a hard `maxCallTabMinutes` backstop for calls whose ending was never
observed (e.g. the extension was reloaded and its storage cleared). `heartbeat.json` exposes
`openCallTabs` and a `tabLeak` warning so growth is visible before it becomes a crash.

**A finished call is no longer re-recorded.** "Was started, and its stream is no longer active"
is ambiguous: either it was stopped by hand mid-call (reacquire it) or the call simply ended
(the extension also auto-stops after 10 minutes of silence). With no terminal state, the second
case looked like the first, so a completed call was re-recorded on every poll for the rest of
`retryWindowMinutes` - duplicate transcripts and a new tab each time. Now a vanished stream is
reacquired only within `reacquireGraceMinutes` of the scheduled start; past that the call is
marked `completed`, which is terminal.

**Pre-call silence no longer eats the retry budget.** The flow joins early, starts the
recording and moves on, so most captures begin before anyone speaks - and the extension stops
a stream after about ten minutes of silence. A call joined at T-15 therefore lost its stream
around T-5 with nothing actually wrong, which the poll loop read as a dead capture and
reacquired: new tab, old tab closed, one attempt spent. Repeat, and all four attempts were gone
before the call began. Now a stopped stream more than `reacquireWithinMinutesOfStart` before
the scheduled start is simply waited out - there is no audio yet to miss - and reacquiring
resumes the moment the call is under way.

**A joined call is not a recorded call.** Three ways a tab that looks perfect records silence,
all three now handled by `playback.js`:

| What the tab looks like | Why it is silent | What happens now |
| --- | --- | --- |
| Player sits on a poster frame behind a Start button | Nothing ever pressed it | The control is found and pressed |
| `<video autoplay muted>` - `paused` is false, `readyState` good | Muted autoplay is the only autoplay Chrome permits, and nobody unmuted it | A gesture is delivered, then it is unmuted |
| No `<audio>`/`<video>` at all; audio runs through WebAudio | Chrome creates an `AudioContext` suspended when there has been no user gesture and never resumes it by itself; a page that starts its audio from a websocket message never asks | The constructor is wrapped before page scripts run, a gesture is delivered to the owning frame, and the context is resumed |

The last one cost TD.TO 2026Q3 and is invisible from the outside - the console said
`The AudioContext was not allowed to start`, and every other field on the capture looked
healthy. `playing` and `audible` are tracked separately for this reason: `playing` is what the
old check tested, and it is exactly the test both of the bottom two rows pass while making no
sound. The ledger records `audioAudible`, and `npm run analyze` judges CAPTURES AT RISK on it.

Gestures are delivered through a transparent full-viewport overlay that takes the click, so no
site control is ever touched - clicking a bare coordinate is the same class of risk that caused
most of the regressions in this project. Activation does not propagate from a parent frame into
an iframe, so the overlay goes into the frame that needs it.

The `AudioContext` wrapper is installed on the browser **context**, not on each call tab: a tab
the site opens for itself has already navigated by the time it is adopted, and an init script
added then is too late to wrap the constructor. It is therefore present on every page in the
watcher's Chrome profile - which is a dedicated profile, and the wrapper is a transparent
`Proxy` that does nothing but retry `resume()` on a gesture.

**Unbounded growth is bounded.** Dedupe records are pruned past `stateRecordTtlDays`; the
unparseable-row warning set is cleared if it grows large (it is keyed partly on the live
countdown text, so a row whose text ticks would otherwise add an entry every poll); logs are
per-day files with `logRetentionDays` retention.

Still manual, and worth knowing: the machine must stay unlocked (see the focus note below), and
nothing supervises the process itself - point a scheduled task at `heartbeat.json` for that.

## Serialization

Each due call's whole pipeline (resolve webcast link → handle registration → trigger extension)
runs one at a time, front-to-back, through a queue in `index.js` (`withPipelineLock`) - not
concurrently across calls. Two reasons: the extension-trigger step needs exclusive control of
"which tab is active" for its duration (see above); and webcast pages/registration forms vary a
lot in layout, so running several unfamiliar pages at once would make a mis-fill by
`formFiller.js`'s best-effort heuristics on one call easy to miss in interleaved logs. The poll
loop itself doesn't block on this queue - it keeps scanning and claims newly-due rows in the
dedupe store immediately, they just wait their turn to actually run.

## One-time setup

### 1. Modify and reload the extension

Already applied if you're reading this after initial setup (see above); otherwise ask Claude to
apply the plan's extension changes to your extension folder.

In `chrome://extensions` (Developer mode on), click **Reload** on "FMP transcripts" after any
change to it. Then go to `chrome://extensions/shortcuts` and confirm "Open the transcription
popup" is bound to **Ctrl+Shift+Y** with scope **In Chrome** (not Global - that scope did not
reliably fire in testing). Sanity-check manually: focus any Chrome tab and press
**Ctrl+Shift+Y** - the popup should open on its own.

### 2. Launch Chrome with remote debugging enabled

Chrome only accepts `--remote-debugging-port` (and other launch flags) at launch. You do **not**
need to close your regular Chrome - a separate `--user-data-dir` runs as an independent window
alongside it:

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\ChromeDebugProfile" --auto-accept-this-tab-capture
```

`--auto-accept-this-tab-capture` is required: without it, `content-script.js`'s
`getDisplayMedia({preferCurrentTab: true, ...})` call shows a native "Allow this site to see
this tab?" consent bubble that isn't part of any page's DOM - Playwright can't click it (same
category of problem as the extension popup, but not even CDP-visible).

Note: an earlier attempt used `--use-fake-ui-for-media-stream` instead, which does auto-accept
the dialog, but testing showed it silently breaks the actual capture - the popup shows a stream
as "active" but no real transcript ever comes through, because that flag is a generic
media-stream *testing* flag that substitutes fake content. `--auto-accept-this-tab-capture` is
a narrower, purpose-built Chromium switch (`chrome_switches.cc`'s `kThisTabCaptureAutoAccept`)
specifically for auto-accepting a real `preferCurrentTab` self-capture request without faking
the underlying stream - verify this with the same YouTube test used to catch the previous flag's
problem (manually start a transcription on a live YouTube video, then check for real transcribed
text) before relying on it for actual calls. It's a launch flag, not a profile setting, so it
must be present every time this Chrome instance is started.

In that window (one-time): log into the admin portal, load the "FMP transcripts" extension
unpacked and pin it, and set its shortcut as above (shortcuts are per-profile).

### 3. Install dependencies

```powershell
cd call-watcher
npm install
```

### Running on macOS

Supported, and verified on a Mac mini: the extension loads, the shortcut fires, the capture
starts without a prompt, and a real transcript comes back.

Two files differ by platform and `extensionTrigger.js`/`preflight.js` choose between them at
runtime. Nothing else in the codebase is platform-specific.

| Job | Windows | macOS |
|---|---|---|
| Inject the keystroke | `src/send-shortcut.ps1` (262 lines) | `src/send-shortcut.applescript` (~20) |
| Check Chrome's launch flags | `Get-CimInstance Win32_Process` | `ps -ax -o command=` |

The size difference is not an accident. Windows refuses to let a background process take the
foreground, so that script attaches input threads, retries, and taps ALT to become eligible.
macOS simply honours `activate`.

What both must do is inject at the same level as real hardware. On Windows, `SendKeys` put the
right window in the foreground - verifiably - and the extension command *still never fired*,
because it posts window messages rather than true input; only `SendInput` worked. AppleScript's
`keystroke` goes through the same path as physical input, which is why it works.

**The shortcut stays `Ctrl+Shift+Y` on both.** Chrome binds a manifest `Ctrl` to the literal
Control key on macOS, not to Command - confirmed by pressing it on the Mac. So no `mac` entry
in the extension manifest is needed, and `extensionShortcutSendKeys` in config.json is read on
both platforms. `shortcutKeys.js` translates it; translating Ctrl to Command would send a
combination nothing listens for, and the silence would be indistinguishable from a failed
injection, so a test asserts Command never appears.

Launching Chrome, all on one line:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir="$HOME/ChromeDebugProfile" --auto-accept-this-tab-capture > /dev/null 2>&1 &
```

`--user-data-dir` creates a **separate, empty profile**, so the extension has to be loaded and
the portal logged into once inside it.

To set up a Mac from scratch, follow [scripts/mac/SETUP.md](scripts/mac/SETUP.md) - the whole
sequence, with every step that went wrong the first time called out rather than left to be
rediscovered. For the unattended-operation half alone - auto-login, no sleep, a Launch Agent
that survives a reboot - see [scripts/mac/README.md](scripts/mac/README.md). The short version is that a locked screen stops
everything, and it stops it silently.

Two things macOS requires that Windows does not:

- **Accessibility permission** for whatever process sends the keystroke, in System Settings >
  Privacy & Security. Without it the keystroke is silently swallowed and every capture fails to
  start. The error message says so when the injector exits with code 3.
- **A real logged-in desktop session** - awake, unlocked, auto-login enabled. The capture
  depends on a keypress landing on a real window, so nothing started over SSH alone can record.
  See `Running-The-Automation-On-Mac-Minis.rtf` in the repository root for the full deployment
  plan, including how to divide calls across several machines.

### Where things live

```
src/                    everything the watcher runs on
  send-shortcut.ps1          RUNTIME (Windows) - the trusted keystroke every capture needs
  send-shortcut.applescript  RUNTIME (macOS) - the same job, twenty lines instead of 262
scripts/                commands you run: supervise, stop, report
scripts/tests/          the automated suite (npm test)
scripts/diagnostics/    probes you run by hand when something specific breaks
test/fixtures/          pages the suite runs against
data/                   logs, ledger, state - all gitignored, all regenerated
```

`scripts/` used to hold all three kinds at once, with `test-` meaning both "part of the suite"
and "a thing I once ran by hand", next to a PowerShell file that was neither. The split is by
what you do with a file, and [scripts/README.md](scripts/README.md) lists every one.

### Knowing nothing was lost

`npm run report` answers the question the log cannot. The outcomes ledger records what was
*attempted*; it is silent about calls that never became an attempt at all - a row whose time
never parsed, a row that never got a dial-in link, or a row that reached the window and
produced no entry whatsoever. A day where twenty calls silently never became due reads, in the
ledger alone, exactly like a quiet day.

So `data/seen-YYYY-MM-DD.json` independently records every row the watcher observed, and the
report reconciles the two. Every call lands in exactly one bucket and the buckets sum to the
total - if they ever do not, the report is wrong and says so rather than quietly under-counting:

```
Reconciliation for 2026-08-24: 199 call(s) observed | recorded=1 failed=1 missed-late=0
  unaccounted=0 no-link=53 unreadable-time=0 not-due-today=144
```

`unaccounted` is the bucket this exists for: a call that entered the window with a usable link
and left no trace. It should always be zero. The report exits non-zero when it is not, so it
can be run from a scheduled task rather than only read by eye. The same block is printed on
Ctrl+C.

`npm run supervise` runs the watcher under a supervisor that restarts it if it exits, and also
if it is running but blind - a stale heartbeat, a disconnected Chrome, an expired portal
session, a table with no readable times. Restarts are rate-limited: five in ten minutes and it
stops and says so, because a process that cannot start is a problem to fix, not to paper over.

Use `npm run stop` rather than hunting for the process. Finding it by hand is genuinely
error-prone and was got wrong twice during development: the command line depends on how it was
launched (`npm start` gives `node  src/index.js`, running it directly gives
`"C:\Program Files\nodejs\node.exe" src/index.js`), so a filter written for one matches
nothing for the other and reports success while the watcher keeps running. A looser filter is
worse - `*src/index.js*` also matches unrelated Node tools. `npm run stop` reads the lock file,
which the watcher writes itself, and confirms the process is actually gone before saying so.

Only one watcher may run at a time (`data/watcher.lock`). Two sharing a Chrome and a data
directory overwrite each other - `processed.json` is rewritten whole from memory, so
last-write-wins can erase a claim and dispatch the same call twice. The lock releases itself on exit - from an exit
hook, so it covers Ctrl+C, a fatal error, a config refusal and a normal end alike, not just the
paths with signal handlers. The one case no code can cover is a hard kill, where the OS gives
the process no chance to run anything: for that, the holder refreshes the lock every poll, and
a lock nobody is refreshing is taken over automatically - so a hard kill never needs manual
cleanup. Checking the pid alone was not enough: Windows recycles pids quickly, and once the OS
hands a dead watcher's number to an unrelated process, a pid-only lock looks held forever.

On Windows a process killed with SIGTERM does not get to run its Node signal handlers, so a
watcher stopped that way never releases its lock or prints its shutdown summary. The staleness
rule covers the lock; use `npm run report` for the summary.

### Tests

```powershell
npm run supervise        # like npm start, but restarts on death OR on a blind heartbeat
npm run stop             # stop the running watcher, whatever it was launched as
npm run report           # "did we get everything today?" - safe to run while it is watching
npm run analyze -- --all # what keeps going wrong, ranked by how many calls it costs
npm test                 # everything: unit, then the four browser suites
npm run test:unit        # pure logic - no browser needed, ~1s
npm run test:registration
npm run test:resolver
npm run test:join        # Zoom-style client-choice interstitials
npm run test:gauntlet    # the wide adversarial sweep (add --verbose for the log)
```

`npm run test:unit` covers the parts that are easy to get subtly wrong and used to have no
coverage at all: the three time formats (including the America/New_York DST math), dedupe keys,
the retry state machine and its attempt cap, log retention, and the fiscal-period split shared
by the write and read paths. It needs no Chrome, so it is the one to run before every commit.

`npm run test:gauntlet` is the broadest of these and the one to run after touching anything in
`joinFlow.js` or `formFiller.js`. Each fixture in `test/fixtures/gauntlet/` declares its own
expectations in `<meta>` tags, so adding a newly-encountered provider means dropping in one HTML
file - no runner changes. It drives the real pipeline in the real order (join flow, form filler,
join flow again, then the relevance guard), which is what makes it catch interaction bugs that
per-helper tests cannot: a click that opens the call in a new tab, a modal that swallows the
click that would have cleared the gate, an entry button whose lingering presence is misread as
an unresolved gate.

The assertion that matters most is `data-forbidden`. An element marked with it must never be
clicked, and most of the damage this project has done came from clicking a plausible wrong
thing - a native-app handler that steals the foreground, a replay link, a "Leave" button. Each
leaves a page that still looks broadly reasonable afterwards, which is exactly why they went
unnoticed. Timing is asserted too (a fixture over 20s fails): everything here runs under the
pipeline lock, so a slow page is not a cosmetic problem, it delays every later call in the same
15-minute window.

The other four need the debug Chrome running (they drive real pages).

`scripts/diagnostics/` holds four probes that are **not** part of `npm test`. Each answers one
question when something specific breaks, and says which in its own header - see
[scripts/README.md](scripts/README.md) for the index. Three are read-only; the exception is
`diag-extension-trigger.js`, which starts a **real** transcription against the active tab, so
use a throwaway symbol and stop the stream from the popup afterwards.

To cover a new provider, open its registration page in the debug Chrome and run
`npm run capture:registration -- <provider> [url-fragment]` (the fragment selects the matching
tab). That writes `test/fixtures/registration/<provider>.html`, which the registration suite
**auto-discovers** - no code change needed - plus a full multi-frame dump under
`test/fixtures/captured/<provider>/` for reference when the gate lives in an iframe (gitignored;
regenerate on demand). Emails, phone numbers, input values, tokens and API-key fields are
redacted before writing. Fixtures named `rejected*.html` are treated as negative cases (the gate
is expected to stay pending).

## Running

```powershell
npm start
```

At startup it verifies Chrome was launched with `--auto-accept-this-tab-capture` and logs an
ERROR if not - without that flag every capture is blocked by a native consent bubble that no
automation can dismiss, which is otherwise invisible until transcripts turn up empty.

It then connects to the already-running Chrome, opens (or reuses) a tab on the portal URL from
`config.json`, and polls the table every `pollIntervalMs`. Each call log includes the pipeline
duration and current queue depth.
If Chrome or the portal tab disconnects, the watcher reconnects and resumes on the next poll.
Calls are recorded in `data/processed.json` to prevent duplicate work,
but each due call is reconciled against the extension's live `activeStreams` storage. If its
matching stream was stopped with the popup's `X` button, or processing failed before a stream
was created, the old claim is removed and the call is retried. Delete `data/processed.json` to
force reprocessing of every eligible call (e.g. while testing).

Stop with **Ctrl+C**. Tabs already opened for in-flight calls are left open, not force-closed.
Shutdown prints a summary of the day (started / failed / missed / recovered-on-retry).

### What it writes to `data/` (and how to check on it)

| File | Purpose |
|---|---|
| `call-watcher-YYYY-MM-DD.log` | One file per day, kept for `logRetentionDays` (14). |
| `outcomes-YYYY-MM-DD.jsonl` | Append-only, one line per call attempt. **Never pruned.** |
| `heartbeat.json` | Overwritten every poll - liveness and what the poll last saw. |
| `processed.json` | Dedupe/retry state. Delete to force reprocessing while testing. |

The two questions that matter after the fact are answered by the first two files:

- *Did we capture X, and was it the right page?* — `outcomes-*.jsonl` records, per attempt, the
  dial-in URL, the URL actually resolved to, the **page title actually recorded**, how late the
  start was versus the scheduled time, and the error on failure. Six captures once ran against a
  page titled "Page Not Found" with nothing recording that fact; this is that record.
- *Is it alive, and is it still seeing data?* — `heartbeat.json`. Its `warnings` block flags the
  "running but blind" states that otherwise look exactly like a quiet day: `noRows` (portal
  session expired or the view changed), `noLinks` (the Dialin Link column moved or was renamed),
  and `queueBacklog`. Those also log at ERROR.

Logs are per-day files rather than one growing file. An earlier version pruned individual log
*lines* older than an hour, which was doubly wrong: it destroyed exactly the evidence needed to
diagnose a morning failure noticed in the afternoon, and it barely worked - entries containing
newlines produce continuation lines with no timestamp, so on a real log only 4 of 293 lines were
even prunable.

For an unattended run, point a scheduled task at `heartbeat.json` and alert if `updatedAt` is
stale by more than ~90s or any `warnings` flag is true. That single check covers every silent
stop: crash, wedged poll, lost Chrome, or expired portal session.

## Configuration (`config.json`)

- `portalUrl` — the "In Call View" page to watch.
- `cdpUrl` — Chrome's remote-debugging endpoint.
- `pollIntervalMs` / `thresholdMinutes` — how often to check, and how soon "soon" means.
- `retryWindowMinutes` — how long after the scheduled start a call remains eligible for
  reacquisition when its matching extension stream was manually stopped or never started.
- `maxAttempts` — maximum automatic attempts after a failed pipeline; retries use bounded
  exponential backoff (30s, 60s, 120s, …) so one broken provider cannot consume the queue
  indefinitely. Note this only works because the poll loop preserves the existing record when
  re-claiming: deleting it first made `claim()` restart the count at 1 every time, which
  silently disabled the cap and pinned the backoff at 30s — roughly 200 retries instead of 4.
- `lateStartGraceMinutes` — how far past the scheduled start an attempt may still **begin**
  (**0**, i.e. not at all). The whole attempt budget is spent inside the `thresholdMinutes`
  window before the call; once it has begun, a call we never got into is treated as missed and
  recorded as `skipped-late`.

  This is stricter than it first looks, and deliberately so. A late join is not a partial
  success, it is a failure shaped like one: it confirms "started", writes a `Done` line, and
  files a transcript missing the opening remarks and guidance — the part of an earnings call
  that matters most — and nothing downstream can tell it apart from a complete transcript. It
  also costs twice, because the pipeline is single-threaded: a doomed retry of a call that has
  already begun holds the lock against calls that have not.

  It applies to retries as well as first attempts. It previously gated only calls with no
  record at all, so a call that failed at minute three of the window went on retrying long
  after the call had started. See `src/dispatchRules.js`.

  The one exception is a call already being **captured** whose stream drops mid-way.
  Reacquiring that is not going back to a missed call, it is keeping a running capture alive,
  and it stays allowed for the whole `reacquireGraceMinutes`. Set a non-zero grace here if you
  would rather have partial captures than none.
- `maxConcurrentPreparations` — how many calls may be **prepared** at once (3). Preparation is
  everything before the extension is triggered: resolving the link, opening the page, walking
  join screens, filling any form. Each call touches only its own tab, so these overlap safely.

  Triggering does **not** overlap, ever, and cannot be configured to. It brings a tab to the
  foreground and drives a popup that closes the instant its tab loses focus, so a second
  trigger — or a tab opened by a preparation — running alongside it captures the wrong tab or
  kills the popup. Both were observed here. That is why a batch prepares everything first and
  only then triggers, one call at a time, in order of urgency: by the time the first trigger
  runs, no preparation is still open to interfere.

  Set it to 1 for a fully serial run. Raising it does not make any individual call faster — it
  shortens the time to get through a batch, which is what decides whether the last call in a
  crowded window still gets attempted before it starts.
- `prepareDeadlineMs` / `triggerDeadlineMs` — per-call ceilings (120s / 90s). These replaced a
  single 5-minute bound that only covered the trigger. That figure was harmless when a slow
  call merely delayed the next one; now that an attempt has to finish before its call starts, a
  call allowed to run for five minutes can push several later calls past their start time and
  lose them outright. Neither bound is reachable by a healthy call — the trigger's own steps
  total about 66s worst case, and preparation is a page load plus at most two hops.
- `streamConfirmTimeoutMs` / `cdpCommandTimeoutMs` / `shortcutTimeoutMs` — bounds on the three
  steps of the trigger path. These exist because the trigger runs inside the pipeline lock, so
  any unbounded wait there stalls not just its own call but every later one for the rest of the
  day. One such hang was verified: the popup closes the instant its tab loses focus, and an
  in-flight CDP command with no close handler never settles.
- `reacquireGraceMinutes` — how long after the scheduled start a vanished stream is treated as
  "stopped by accident, reacquire it" rather than "the call ended" (30). Past this the call is
  marked `completed`, which is terminal - see "Running indefinitely".
- `reacquireWithinMinutesOfStart` — how close to the scheduled start a vanished stream begins to
  count as a real failure (1). Earlier than this it is pre-call silence and is waited out rather
  than restarted. Raise it for a provider that opens its line early and has audio playing before
  the scheduled time.
- `maxCallTabMinutes` — backstop age at which a call tab is closed even if completion was
  never observed (180).
- `stateRecordTtlDays` — how long dedupe records are kept (7). They can never be replayed once
  their date passes, but they used to accumulate forever.
- `logRetentionDays` — how many daily log files to keep (14). The outcomes ledger is never pruned.
- `popupTimeoutMs` — how long to wait for the popup to appear via CDP after sending the
  shortcut (the stream-item confirmation step afterward has its own `streamConfirmTimeoutMs`
  budget, unaffected by this value). Set higher than you'd expect (18s) because
  of a real observed failure: MV3 puts the extension's service worker to sleep after ~30s of
  inactivity, and the first shortcut of a session can trigger a "cold start" (Chrome has to
  spin the service worker back up before `background.js` even runs) that takes meaningfully
  longer than a warm one - confirmed live, the first call in a session timed out at exactly 8s
  while every subsequent call in the same run resolved in under a second.
- `extensionShortcutSendKeys` — SendKeys-style syntax for the shortcut (`^+y` = Ctrl+Shift+Y,
  parsed by `send-shortcut.ps1` into actual `SendInput` key codes). Must match `manifest.json`'s
  `commands.trigger-transcription-popup.suggested_key`.
- `extensionId` — **machine-specific; set this in `config.local.json`, not here.** Chrome
  derives an unpacked extension's ID from its install path, so every machine/profile gets a
  different one. Committed as `null` on purpose: auto-detection from the running service worker
  is attempted first, but MV3 workers sleep when idle, so a dormant worker looks identical to a
  missing extension - which is exactly why setting it explicitly per machine is more reliable.
- `dummyIdentity` — values used to fill webcast registration gates.
- `knownDirectProviderDomains` — hostnames treated as already being the real webcast page,
  skipping the "find the real link" heuristic. Add new providers here as they come up.

### Machine-specific overrides (`config.local.json`)

`src/loadConfig.js` shallow-merges an optional, gitignored `config.local.json` over
`config.json`, so per-machine settings never travel through git. This matters most for
`extensionId`: with it committed, two machines pushing to the same repo overwrite each other's
value on every pull, silently breaking the extension-trigger step until someone notices.

Create one per machine (get the ID from `chrome://extensions`):

```json
{
  "extensionId": "your-machines-extension-id-here"
}
```

Any top-level key works, so this is also the right place for temporary local tweaks like a
raised `thresholdMinutes` while testing - keeping the committed default at the production value
instead of accidentally pushing a test setting.

## Known rough edges

- The portal's table is a custom div grid with hashed CSS-module class names, not a real
  `<table>`. `tableWatcher.js` reconstructs rows by geometry (matching header label text to
  on-screen X position, then matching cells to rows by Y position) instead of relying on
  markup/classes, so it survives deploys that change class-name hashes. It assumes rows within
  a day are sorted soonest-first and only reads the currently-rendered page of each date-group's
  table — if a day ever has more rows than fit on one page, later pages won't be scanned until
  pagination-following is added.
- Countdown parsing falls back to the rendered "X days Y hrs Z min W sec" text (no raw epoch
  attribute has been found on the cell so far) — worth tightening if a more direct data source
  ever turns up.
- `webcastResolver.js` resolves an IR landing page in tiers, tried in order on each page it
  looks at: (1) is the page itself already on a known provider domain
  (`knownDirectProviderDomains` in `config.json` - grow this list from real cases seen in the
  logs), (2) is the player embedded via `<iframe>` from a known domain (stay on the page -
  `preferCurrentTab` capture grabs the whole tab anyway), (3) is there a link pointing to a
  known provider domain regardless of its wording, (4) fall back to matching link text like
  "webcast"/"listen live"/"join call". If none of those find anything on the first page, it
  follows one bounded hop through an obvious navigational link ("Investor Relations"/"Events"/
  "Webcasts") and retries tiers 1-4 there (`MAX_HOPS` in the file, currently 2 pages total) -
  covers the case where the real webcast link is one click deeper than wherever the admin
  portal's dial-in link lands. A genuinely new IR platform that's neither a known domain,
  obviously-worded, nor reachable via an obvious nav link may still need a new pattern (a
  warning is logged when nothing is recognized after all of the above).
  Both the text-match and nav-link checks require the matched text to be under
  `MAX_CTA_TEXT_LENGTH` (60 chars) - without it, a long footer/branding line that merely
  *contains* a matching keyword (e.g. "Webcasting Platform Powered by ACCESS Newswire Inc. ©
  Copyright 2026...") can match and send the resolver to a generic marketing page instead of
  the real webcast, which the original link had already pointed to directly - seen live on a
  real call. Be similarly careful adding new `knownDirectProviderDomains`: `q4cdn.com` looked
  like a safe addition (Q4's platform) but turned out to also be Q4's generic file-hosting CDN,
  causing a different real call to resolve to a PDF earnings presentation instead of its
  webcast - only add a domain once it's confirmed to host webcast players specifically, not
  just "some Q4/media-server/etc.-family domain."
- `joinFlow.js` handles gates that are a choice of CLIENT rather than a form. Zoom's lobby is
  the reference case: `zoom.us/j/<id>` shows "Join from Zoom Workplace app" and "Join from
  browser" over no input fields at all, so `formFiller.js` correctly reported no registration
  gate - and the pipeline recorded the lobby. Two rules matter here. First, the native-app
  option must never be clicked: it fires a `zoommtg://` handler whose OS dialog takes the
  foreground, and the foreground is what the extension keystroke needs seconds later, so
  clicking it breaks the step after it as well as its own. `NATIVE_APP_PATTERN` is checked in
  both `joinFlow.js` and `formFiller.js` for that reason - `formFiller`'s CTA scoring matches
  the bare word "join", which that button contains. Second, the page's own browser link is
  preferred over `zoomWebClientUrl()`'s constructed `app.zoom.us/wc/<id>/join` address, because
  Zoom's link carries state we cannot always reproduce; the constructed URL is the fallback for
  when the link is absent. A new provider with different wording needs an entry in
  `BROWSER_ENTRY_PATTERN`, and will otherwise surface as a refused capture rather than a
  wrong one.
- `formFiller.js` matches common field naming/proximity patterns and falls back to a
  button-only click flow (for account-based gates like Q4); an unusual registration form may
  still need a new entry in `FIELD_PATTERNS` or `CTA_BUTTON_PATTERN`.
- `send-shortcut.ps1` matches the target window by title substring; if a page's title is
  something generic that happens to collide with another window's title, it could focus the
  wrong one. Not observed in testing, but worth knowing if the shortcut ever seems to fire on
  the wrong tab.
