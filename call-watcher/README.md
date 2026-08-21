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

Opening the extension's popup and filling it turned out to need three non-obvious pieces,
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
2. **Finding the right OS window isn't just "Chrome's main window."** A `chrome.exe` process
   can own more than one top-level window (e.g. a webcast link that opens its player in a
   separate popup window, not just a new tab) - `Process.MainWindowHandle` only ever reports
   one of them, ambiguously. `send-shortcut.ps1` enumerates every visible top-level window
   across every `chrome.exe` process matching `--remote-debugging-port`, and picks the one
   whose title matches the actual target tab (passed in from `extensionTrigger.js` via
   `targetPage.title()`), falling back to `MainWindowHandle` if no title matches.
3. **Playwright never sees the popup as a page.** Confirmed directly with
   `scripts/diagnose-popup.js`: the popup opens visibly and is listed by Chrome's own
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

### Tests

```powershell
npm test               # everything: unit, then the two browser suites
npm run test:unit      # pure logic - no browser needed, ~1s
npm run test:registration
npm run test:resolver
```

`npm run test:unit` covers the parts that are easy to get subtly wrong and used to have no
coverage at all: the three time formats (including the America/New_York DST math), dedupe keys,
the retry state machine and its attempt cap, log retention, and the fiscal-period split shared
by the write and read paths. It needs no Chrome, so it is the one to run before every commit.

The other two need the debug Chrome running (they drive real pages). Two further scripts are
manual diagnostics rather than tests - `scripts/test-extension-trigger.js <SYM> <YEAR> <Q>`
drives the whole popup path once and prints the timing, and `scripts/test-click-resolver.js
<SYM>` resolves one truncated link. Both start a **real** transcription against whatever tab is
active, so stop the stream from the popup afterwards.

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
- `lateStartGraceMinutes` — how far past the scheduled start a call may be **first** attempted
  (10). Beyond this it is recorded as `skipped-late` rather than started, because joining an
  hour late still "succeeds" and would otherwise make a total miss look like a capture.
  Reacquiring a call that *was* started stays allowed for the whole `retryWindowMinutes`.
- `streamConfirmTimeoutMs` / `cdpCommandTimeoutMs` / `shortcutTimeoutMs` — bounds on the three
  steps of the trigger path. These exist because the trigger runs inside the pipeline lock, so
  any unbounded wait there stalls not just its own call but every later one for the rest of the
  day. One such hang was verified: the popup closes the instant its tab loses focus, and an
  in-flight CDP command with no close handler never settles.
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
- `formFiller.js` matches common field naming/proximity patterns and falls back to a
  button-only click flow (for account-based gates like Q4); an unusual registration form may
  still need a new entry in `FIELD_PATTERNS` or `CTA_BUTTON_PATTERN`.
- `send-shortcut.ps1` matches the target window by title substring; if a page's title is
  something generic that happens to collide with another window's title, it could focus the
  wrong one. Not observed in testing, but worth knowing if the shortcut ever seems to fire on
  the wrong tab.
