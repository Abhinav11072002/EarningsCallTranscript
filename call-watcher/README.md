# call-watcher

Watches the admin portal's "In Call View" (Upcoming) table. For every call starting within
`thresholdMinutes` (default 15) it opens the dial-in link, resolves the real webcast link if
needed, handles the registration gate (fills identity fields, or clicks through an
account-based flow like Q4 Inc.'s events platform), joins the call, and triggers the pinned
"FMP transcripts" Chrome extension to start transcription with the right Symbol/Year/Period.

See `../.claude/plans/validated-honking-puddle.md` (or ask Claude) for the original design
reasoning. The actual extension-trigger mechanism ended up more involved than that plan assumed
(see below) - several real Chrome/Windows quirks only showed up under live testing.

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

## Running

```powershell
npm start
```

This connects to the already-running Chrome, opens (or reuses) a tab on the portal URL from
`config.json`, and polls the table every `pollIntervalMs`. Logs go to the console and to
`data/call-watcher.log`. Processed calls are recorded in `data/processed.json` so restarts don't
re-join a call that's already been handled - delete that file to force reprocessing (e.g. while
testing).

Stop with **Ctrl+C**. Tabs already opened for in-flight calls are left open, not force-closed.

## Configuration (`config.json`)

- `portalUrl` — the "In Call View" page to watch.
- `cdpUrl` — Chrome's remote-debugging endpoint.
- `pollIntervalMs` / `thresholdMinutes` — how often to check, and how soon "soon" means.
- `popupTimeoutMs` — how long to wait for the popup to appear via CDP, and separately, how long
  to wait for this row's own stream-item to be confirmed active.
- `extensionShortcutSendKeys` — SendKeys-style syntax for the shortcut (`^+y` = Ctrl+Shift+Y,
  parsed by `send-shortcut.ps1` into actual `SendInput` key codes). Must match `manifest.json`'s
  `commands.trigger-transcription-popup.suggested_key`.
- `extensionId` — leave `null` to auto-detect from the extension's service worker; set manually
  (from `chrome://extensions`) if auto-detection ever fails.
- `dummyIdentity` — values used to fill webcast registration gates.
- `knownDirectProviderDomains` — hostnames treated as already being the real webcast page,
  skipping the "find the real link" heuristic. Add new providers here as they come up.

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
- `formFiller.js` matches common field naming/proximity patterns and falls back to a
  button-only click flow (for account-based gates like Q4); an unusual registration form may
  still need a new entry in `FIELD_PATTERNS` or `CTA_BUTTON_PATTERN`.
- `send-shortcut.ps1` matches the target window by title substring; if a page's title is
  something generic that happens to collide with another window's title, it could focus the
  wrong one. Not observed in testing, but worth knowing if the shortcut ever seems to fire on
  the wrong tab.
