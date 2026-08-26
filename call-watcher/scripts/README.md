# scripts/

Three kinds of thing used to live here under one `test-` prefix that meant two different
things, next to a file that was neither. They are now separated by what you actually do with
them.

## scripts/ — commands you run

| Command | Script | What it does |
|---|---|---|
| `npm run supervise` | `supervisor.js` | Runs the watcher and restarts it if it exits or goes blind. Use this instead of `npm start` for an unattended day. |
| `npm run stop` | `stop.js` | Stops the running watcher, whatever it was launched as. Reads `data/watcher.lock`, which the watcher writes itself. |
| `npm run report` | `report.js` | "Did we get everything today?" Safe to run in a second terminal while the watcher works. |

## scripts/tests/ — the automated suite

Everything `npm test` runs. All of these are safe: none starts a real transcription or posts
anything to the backend.

| Script | Covers |
|---|---|
| `test-unit.js` | Pure logic — no browser needed, about a second. Time parsing and DST, the retry state machine, dedupe keys, the instance lock, config validation, reconciliation, batch ordering. Run this before every commit. |
| `test-form-filler.js` | Registration fixtures in `test/fixtures/registration/`. |
| `test-webcast-resolver.js` | Link resolution against a local server — IR pages, PDFs, archived quarters, dead links. |
| `test-join-flow.js` | Client-choice interstitials: Zoom's lobby, the native-app trap. |
| `test-gauntlet.js` | The wide sweep — 25 fixtures through the real pipeline in the real order. Run this after touching `joinFlow.js` or `formFiller.js`. |

`capture-registration-fixture.js` (`npm run capture:registration <provider>`) is the tool that
turns a real provider page into a fixture for the suite above.

## scripts/diagnostics/ — probes you run by hand

**Not part of `npm test`.** Each answers one question when something specific is broken; each
says which question in its own header.

| Script | Answers | Safe? |
|---|---|---|
| `diag-popup.js` | Does Playwright see the extension popup at all? | yes |
| `diag-click-resolver.js` | What URL does the portal actually open for this symbol? | yes |
| `diag-popup-reliability.js` | Does the popup open and fill *every* time, or only usually? | yes — stops before Start |
| `diag-extension-trigger.js` | Is the trigger path working, and how fast? | **no — starts a real transcription** |
| `diag-form-fields.js` | What does the form filler see, and what would it type where? | yes |

## What is deliberately NOT here

`send-shortcut.ps1` and `send-shortcut.applescript` live in **`src/`**, with the code that calls
them. They are runtime code: one of them runs on every call, forcing Chrome to the foreground
and injecting the trusted keystroke that the capture depends on. `extensionTrigger.js` picks
between them by platform. The PowerShell one sat in this folder for a while, among the test
scripts, one tidy-up away from being deleted as scaffolding.
