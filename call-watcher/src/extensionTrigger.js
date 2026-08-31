const { execFile } = require('child_process');
const path = require('path');
const http = require('http');
const { describeJoinBlocker } = require('./joinFlow');
const { judgeRelevance, playerProbe } = require('./pageRelevance');
const { parseSendKeys, toAppleScriptArgs, describeShortcut } = require('./shortcutKeys');

// Both beside this file on purpose. They are runtime code, not tooling: every capture depends
// on one of them, and while the PowerShell one sat in scripts/ among the test files it was one
// tidy-up away from being deleted as scaffolding.
const SEND_SHORTCUT_SCRIPT = path.join(__dirname, 'send-shortcut.ps1');
const SEND_SHORTCUT_APPLESCRIPT = path.join(__dirname, 'send-shortcut.applescript');

// The two platforms need genuinely different mechanisms, not a flag. Windows has to fight for
// the foreground (attach input threads, retry, tap ALT) and must inject via SendInput, because
// window-message keystrokes focus the window but never fire the extension command. macOS just
// honours `activate`, and AppleScript's keystroke goes through the same path as real hardware.
// Both were verified on their own machines; neither approach works on the other platform.
function buildShortcutCommand(sendKeysSequence, config, titleHint, platform = process.platform) {
  if (platform === 'darwin') {
    const parsed = parseSendKeys(sendKeysSequence);
    return {
      file: 'osascript',
      args: [SEND_SHORTCUT_APPLESCRIPT, ...toAppleScriptArgs(parsed), titleHint || ''],
      label: 'send-shortcut.applescript',
      shortcut: describeShortcut(parsed),
      // osascript writes its `log` output to stderr; PowerShell writes to stdout. Recorded here
      // so the caller does not have to ask what platform it is on a second time.
      diagnosticsOnStderr: true,
    };
  }
  // Windows identifies the target Chrome by its --remote-debugging-port, which is unambiguous
  // even when the user's ordinary Chrome is also running. macOS has no equivalent need: it
  // addresses the application by name and picks the window by tab title.
  const port = new URL(config.cdpUrl).port;
  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', SEND_SHORTCUT_SCRIPT, '-Port', port, '-Keys', sendKeysSequence,
  ];
  if (titleHint) args.push('-TitleHint', titleHint);
  return {
    file: 'powershell.exe',
    args,
    label: 'send-shortcut.ps1',
    shortcut: sendKeysSequence,
    diagnosticsOnStderr: false,
  };
}

const DEFAULT_SHORTCUT_TIMEOUT_MS = 30000;
const DEFAULT_CDP_COMMAND_TIMEOUT_MS = 10000;
const DEFAULT_POPUP_TIMEOUT_MS = 18000;
const DEFAULT_STREAM_CONFIRM_TIMEOUT_MS = 8000;

// Sends the extension's keyboard shortcut via src/send-shortcut.ps1, which finds the
// exact chrome.exe process matching --remote-debugging-port (unambiguous, unlike matching by
// window title when the user's regular Chrome is also open) and forces real OS-level
// foreground focus onto it before sending the keys. Plain CDP page.bringToFront() alone isn't
// enough here - it doesn't reliably grant true OS foreground focus, and chrome.action.openPopup()
// fails with "Could not find an active browser window" without it.
// This is the one step that must be a real, trusted OS-level gesture: the extension's
// getDisplayMedia() capture relies on Chrome's activeTab grant, which only follows a
// genuine user gesture invoking the extension (see manifest/background.js changes).
//
// The script exits non-zero when it could not actually put the target window in the
// foreground, or when SendInput did not inject every event - either means the keystroke did
// not land on the intended tab, which previously surfaced as a confusing popup timeout (or
// worse, drove a stale popup against the wrong tab). A timeout is set because a wedged
// PowerShell process would otherwise hang this call forever, and it runs inside the pipeline
// lock - stalling every later call for the rest of the day.
function sendGlobalShortcut(sendKeysSequence, config, titleHint, logger) {
  return new Promise((resolve, reject) => {
    const command = buildShortcutCommand(sendKeysSequence, config, titleHint);
    const timeout = Number(config.shortcutTimeoutMs ?? DEFAULT_SHORTCUT_TIMEOUT_MS);
    execFile(command.file, command.args, { timeout }, (err, stdout, stderr) => {
      // Collapsed to one line on purpose: the logger writes one entry per call, so an embedded
      // newline produces continuation lines with no timestamp - which log rotation cannot
      // attribute to a time and therefore never prunes.
      // osascript writes its `log` output to stderr, PowerShell to stdout - so both are read
      // here, and the diagnostics survive on either platform rather than vanishing on one.
      const streams = [stdout, command.diagnosticsOnStderr ? stderr : ''];
      const out = streams.join('\n').trim().split(/\r?\n/).filter(Boolean).join(' | ');
      if (out && !err) logger.info(`${command.label}: ${out}`);
      if (err) {
        // PowerShell error records are enormous (the message, then CategoryInfo and
        // FullyQualifiedErrorId, often duplicated). Keep just the human sentence so the log
        // line and the outcomes ledger stay readable.
        const firstSentence = (stderr || '')
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find((l) => l && !l.startsWith('+') && !/^(CategoryInfo|FullyQualifiedErrorId)/.test(l));
        const detail = (firstSentence || '').replace(/^.*send-shortcut\.(ps1|applescript)\s*:\s*/, '').trim();
        const reason = err.killed ? `timed out after ${timeout}ms` : detail || err.message;
        // Exit 3 on macOS almost always means one specific, fixable thing, and saying so beats
        // making someone infer it from an AppleScript error number.
        const hint =
          process.platform === 'darwin' && err.code === 3
            ? ' (on macOS this usually means Chrome is not running, or this process has not been ' +
              'granted Accessibility permission in System Settings > Privacy & Security)'
            : '';
        reject(new Error(`Focus/keystroke injection failed: ${reason}${hint}`));
      } else resolve();
    });
  });
}

async function getExtensionId(context, config) {
  // MV3 service workers sleep when idle, so an unloaded worker is not evidence that
  // the extension is missing. Prefer the stable ID of the unpacked extension.
  if (config.extensionId) return config.extensionId;
  const workers = context.serviceWorkers();
  for (const w of workers) {
    const m = w.url().match(/^chrome-extension:\/\/([a-p]{32})\//);
    if (m) return m[1];
  }
  throw new Error(
    'Could not auto-detect the extension ID from its service worker. ' +
      'Set "extensionId" in config.local.json (copy it from chrome://extensions) - it is ' +
      'machine-specific, so it must not go in the committed config.json.'
  );
}

function splitFiscalPeriod(fiscalPeriod) {
  const m = /^(\d{4})(.*)$/.exec((fiscalPeriod || '').trim());
  if (m) return { year: m[1], period: m[2].trim() };
  return { year: '', period: fiscalPeriod || '' };
}

// Reads the extension's whole activeStreams list in ONE round trip.
//
// This deliberately returns the raw list rather than answering "is row X active?" per row.
// Verified by direct test: opening a tab (which this must do - chrome.storage is only
// reachable from an extension page) DESTROYS an open extension popup. The poll loop used to
// call a per-row check, so a poll landing while a pipeline was mid-trigger would kill that
// pipeline's own popup, and the in-flight CDP call would then never settle. One read per poll,
// taken inside the pipeline lock by the caller, removes the race and the N-tab churn together.
async function getActiveStreams(context, config) {
  const extensionId = await getExtensionId(context, config);
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    const streams = await page.evaluate(() => new Promise((resolve) => {
      chrome.storage.local.get(['activeStreams'], ({ activeStreams = [] }) => resolve(activeStreams));
    }));
    return Array.isArray(streams) ? streams : [];
  } finally {
    await page.close().catch(() => {});
  }
}

// Matches a scraped row against the extension's own stream records. Uses the same
// splitFiscalPeriod as the code that WRITES those records, so a period the regex cannot split
// can never be written one way and looked up another (which would make a successful start
// look inactive forever, and re-trigger a duplicate recording every poll).
function streamMatchesRow(streams, row) {
  const { year, period } = splitFiscalPeriod(row.fiscalPeriod);
  return (streams || []).some((s) => s && s.symbol === row.symbol && s.year === year && s.period === period);
}

// Confirmed by direct testing (scripts/diagnose-popup.js): the popup opens visibly and is
// listed by Chrome's own /json/list HTTP endpoint, but Playwright's context.pages()/'page'
// event NEVER sees it - its auto-attach mechanism doesn't reach this target, most likely
// because it isn't spawned as a child of any target Playwright already tracks. So the popup
// is found and driven entirely through a raw CDP connection instead of Playwright's Page API.
function httpGetJson(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`CDP /json/list timed out after ${timeoutMs}ms`)));
  });
}

async function findPopupTarget(cdpUrl, extensionId, timeoutMs) {
  const targetPrefix = `chrome-extension://${extensionId}/popup.html`;
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    const targets = await httpGetJson(`${cdpUrl}/json/list`).catch((err) => {
      lastError = err;
      return [];
    });
    const match = targets.find((t) => t.url && t.url.startsWith(targetPrefix));
    if (match) return match;
    await new Promise((r) => setTimeout(r, 150));
  }
  // Distinguish "Chrome is not answering" from "the keystroke did not open a popup" - these
  // have completely different fixes and used to produce the same misleading message.
  if (lastError) throw new Error(`Timed out waiting for the extension popup; CDP endpoint was unhealthy: ${lastError.message}`);
  throw new Error('Timed out waiting for the extension popup to open (shortcut may not have reached Chrome)');
}

// Every command is bounded three ways: a matching reply, the socket closing, or a timeout.
// The socket-close path is the important one - the popup closes the moment its tab loses
// focus, and an in-flight command with no close handler NEVER settles (verified directly).
// Because triggerExtension runs inside the pipeline lock, one such hang used to wedge the
// queue permanently: no call would ever run again, while the poll loop kept logging normally.
function sendCdpCommand(ws, id, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      ws.removeEventListener('close', onClose);
      ws.removeEventListener('error', onError);
    };
    const settle = (fn, arg) => {
      if (done) return;
      done = true;
      cleanup();
      fn(arg);
    };
    const onMessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.id !== id) return;
      if (msg.error) settle(reject, new Error(`CDP ${method} failed: ${msg.error.message}`));
      else settle(resolve, msg.result);
    };
    const onClose = () => settle(reject, new Error(`CDP ${method} aborted: popup closed before replying (it closes when its tab loses focus)`));
    const onError = () => settle(reject, new Error(`CDP ${method} aborted: WebSocket error`));
    const timer = setTimeout(() => settle(reject, new Error(`CDP ${method} timed out after ${timeoutMs}ms`)), timeoutMs);

    ws.addEventListener('message', onMessage);
    ws.addEventListener('close', onClose);
    ws.addEventListener('error', onError);
    try {
      ws.send(JSON.stringify({ id, method, params }));
    } catch (err) {
      settle(reject, new Error(`CDP ${method} could not be sent: ${err.message}`));
    }
  });
}

// Opens a raw CDP WebSocket session directly to the popup's own target and exposes a small
// evaluate() helper - this runs JS in the popup's page context, same as if popup.js itself
// had done it. That's fine for filling fields/clicking Start: those don't need to be "trusted"
// user actions themselves, unlike the earlier getDisplayMedia() call, whose activeTab grant
// was already satisfied by the real keypress that opened this popup in the first place.
async function openCdpSession(webSocketDebuggerUrl, commandTimeoutMs) {
  const ws = new WebSocket(webSocketDebuggerUrl);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out opening popup CDP WebSocket after ${commandTimeoutMs}ms`)), commandTimeoutMs);
      const ok = () => { clearTimeout(timer); resolve(); };
      const fail = (msg) => () => { clearTimeout(timer); reject(new Error(msg)); };
      ws.addEventListener('open', ok, { once: true });
      ws.addEventListener('error', fail('WebSocket error connecting to popup CDP target'), { once: true });
      ws.addEventListener('close', fail('Popup CDP target closed before the connection opened'), { once: true });
    });
  } catch (err) {
    // Do not leak the socket when the handshake fails or times out.
    try { ws.close(); } catch {}
    throw err;
  }

  let nextId = 1;
  const send = (method, params) => sendCdpCommand(ws, nextId++, method, params, commandTimeoutMs);
  try {
    await send('Runtime.enable', {});
  } catch (err) {
    try { ws.close(); } catch {}
    throw err;
  }
  return {
    evaluate: async (expression) => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) {
        throw new Error(`Popup script error: ${result.exceptionDetails.text || JSON.stringify(result.exceptionDetails)}`);
      }
      return result.result ? result.result.value : undefined;
    },
    close: () => { try { ws.close(); } catch {} },
  };
}

// Pages the pipeline should never start a recording on: resolution landed on an error page or
// an unrelated page rather than the call. Capture is auto-accepted
// (--auto-accept-this-tab-capture), so there is no human gate to catch this - it has already
// happened in practice, with six triggers firing on a page titled "Page Not Found".
const BAD_TARGET_TITLE_PATTERN = /page not found|404|not found|access denied|forbidden|error occurred|are you a robot|just a moment/i;

// Pages that are clearly a past recording rather than the live call. Recording one of these
// produces a transcript of the WRONG quarter, filed under the right symbol - indistinguishable
// from a correct capture unless it is caught here.
const REPLAY_TITLE_PATTERN = /\breplay\b|\barchive[sd]?\b|on-?demand|\btranscript\b/i;

// Checks the page we are about to record actually relates to THIS call before capture starts.
//
// This is the gap that made every resolution bug silent: the only prior checks were an
// error-page title regex and, afterwards, reading back a stream label that we typed ourselves.
// So an archived quarter, a provider's marketing homepage, a PDF viewer or another company's
// call all confirmed as "started" and were logged Done. Because capture is auto-accepted there
// is no human gate either.
//
// The judgement is in pageRelevance.js; this does the browser work and the refusing. It was
// deliberately permissive once, on the reasoning that a false refusal costs one retry while a
// false accept costs a transcript. That reasoning was right and the implementation was not: on
// a full day it accepted 7 pages out of 26 that had no audio at all, each recording silence and
// reporting success. Permissive about WHICH call, strict about whether there is a call.
// How long to keep asking whether a player has appeared before concluding there is none.
//
// webcasting.bizconf.cn renders its player about EIGHT seconds after the document is ready -
// measured directly: at 3s there is no player element at all, at 8s there is a 792x446 one. The
// probe ran once, immediately, saw nothing, and the call was refused for having no player.
// 600036.SS and CIHKY 2026Q2 both died that way, on a page 339 people were watching.
//
// Only the absence is retried. A page that already has a player answers on the first look, so
// this costs nothing on every provider that behaves.
const PLAYER_WAIT_MS = 15000;
const PLAYER_POLL_MS = 1500;

async function probeForPlayer(page, logger) {
  const deadline = Date.now() + PLAYER_WAIT_MS;
  let probe = await page.evaluate(playerProbe).catch(() => null);
  if (!probe || probe.hasPlayer) return probe;

  while (Date.now() < deadline) {
    await page.waitForTimeout(PLAYER_POLL_MS);
    const next = await page.evaluate(playerProbe).catch(() => null);
    if (!next) return probe; // page went away; keep what we had
    probe = next;
    if (probe.hasPlayer) {
      logger.info('The player appeared after a delay; it was not there on the first look.');
      return probe;
    }
  }
  return probe;
}

async function assertPageLooksRelevant(page, row, logger, config, dialinUrl) {
  const probe = await probeForPlayer(page, logger);
  if (!probe) return; // cannot inspect; the other guards still apply

  if (REPLAY_TITLE_PATTERN.test(probe.title)) {
    throw new Error(`Refusing to record: page looks like a replay/archive, not the live call ("${probe.title}")`);
  }

  // A pre-join screen is disqualifying on its own, whatever else the page says. This is the
  // check that would have caught NSCIF 2026Q2: its lobby page satisfied the weakest tier below
  // ("a player element plus 2026" - Zoom's own copyright line supplied the year), so twenty
  // minutes were recorded from a page whose visible content was a "Join from browser" button.
  // Unlike the identity tiers, this is not about naming the right company: it is the difference
  // between being in the call and standing outside it.
  const blocker = await describeJoinBlocker(page).catch(() => null);
  if (blocker) {
    throw new Error(
      `Refusing to record: not inside the call yet - ${blocker} (title "${probe.title}", url ${probe.url})`
    );
  }

  // The judgement itself lives in pageRelevance.js as a pure function, tested against the real
  // page titles from the run where it got 7 of 26 wrong. What it turns on now is whether the
  // page has anything that can PLAY: all 19 genuine captures did, and all 7 empty ones - five
  // registration pages and two company homepages - did not.
  const { year: fpYear, period: fpPeriod } = splitFiscalPeriod(row.fiscalPeriod);
  const verdict = judgeRelevance({
    title: probe.title,
    url: probe.url,
    text: probe.text,
    hasPlayer: probe.hasPlayer,
    symbol: row.symbol,
    year: fpYear,
    period: fpPeriod,
    dialinUrl,
  });

  if (!verdict.accepted) {
    const message =
      `${verdict.reason} (title "${probe.title}", url ${probe.url}) - ` +
      `refusing to record ${row.symbol} ${row.fiscalPeriod}`;
    // Escapable without a code change: if a legitimate call page is ever refused, set
    // requirePageRelevance=false in config.local.json to downgrade this to a warning rather
    // than editing the check out.
    if (config && config.requirePageRelevance === false) {
      logger.warn(`Relevance check would have refused this page, but is disabled: ${message}`);
      return;
    }
    throw new Error(`Refusing to record: ${message}`);
  }
  logger.info(`Target page relevance check passed on ${verdict.reason}.`);
}

// Brings the call tab to front, triggers the popup via the global shortcut, then finds and
// drives it via raw CDP (Symbol/Year/Period + Start Transcription).
async function triggerExtension(context, targetPage, row, config, logger, dialinUrl) {
  const extensionId = await getExtensionId(context, config);
  const commandTimeoutMs = Number(config.cdpCommandTimeoutMs ?? DEFAULT_CDP_COMMAND_TIMEOUT_MS);

  await targetPage.bringToFront();
  const titleHint = await targetPage.title().catch(() => '');

  if (BAD_TARGET_TITLE_PATTERN.test(titleHint)) {
    throw new Error(`Refusing to record: resolved page looks like an error/unrelated page ("${titleHint}")`);
  }
  await assertPageLooksRelevant(targetPage, row, logger, config, dialinUrl);

  await sendGlobalShortcut(config.extensionShortcutSendKeys, config, titleHint, logger);

  const popupTarget = await findPopupTarget(config.cdpUrl, extensionId, Number(config.popupTimeoutMs ?? DEFAULT_POPUP_TIMEOUT_MS));
  logger.info(`Found popup target via CDP: ${popupTarget.id}`);

  const session = await openCdpSession(popupTarget.webSocketDebuggerUrl, commandTimeoutMs);
  try {
    const { year, period } = splitFiscalPeriod(row.fiscalPeriod);

    const fillResult = await session.evaluate(`
      (function() {
        const symbolEl = document.getElementById('symbol');
        const yearEl = document.getElementById('year');
        const periodEl = document.getElementById('period');
        if (!symbolEl || !yearEl || !periodEl) return 'fields-not-found';
        symbolEl.value = ${JSON.stringify(row.symbol)};
        yearEl.value = ${JSON.stringify(year)};
        periodEl.value = ${JSON.stringify(period)};
        [symbolEl, yearEl, periodEl].forEach((el) => el.dispatchEvent(new Event('input', { bubbles: true })));
        return 'ok';
      })();
    `);
    if (fillResult !== 'ok') throw new Error(`Could not fill popup fields (${fillResult})`);
    logger.info(`Filled popup: symbol=${row.symbol} year=${year} period=${period}`);

    const clickResult = await session.evaluate(`
      (function() {
        const btn = document.getElementById('start');
        if (!btn) return 'button-not-found';
        btn.click();
        return 'ok';
      })();
    `);
    if (clickResult !== 'ok') throw new Error(`Could not click Start button (${clickResult})`);

    // Check for a stream-item matching THIS row specifically - activeStreams persists in
    // chrome.storage.local across popup open/close cycles, so a bare "any .stream-item exists"
    // check would false-positive on a PREVIOUS call's still-active stream the instant this
    // popup reopens (popup.js's own click handler has a 300ms debounce plus a network fetch
    // for the Deepgram key before it actually adds its own entry - much slower than that false
    // positive). A false positive here would make us advance to the next row - closing this
    // popup, and switching the active tab - before this row's own click handler has actually
    // run, so it would never really start, and worse, could end up recording on the wrong tab.
    const expectedLabel = `${row.symbol} - ${year} ${period}`;
    const confirmExpr = `Array.from(document.querySelectorAll('.stream-item')).some((el) => el.textContent.includes(${JSON.stringify(expectedLabel)}))`;
    const deadline = Date.now() + Number(config.streamConfirmTimeoutMs ?? DEFAULT_STREAM_CONFIRM_TIMEOUT_MS);
    let started = false;
    let lastConfirmError = null;
    while (Date.now() < deadline) {
      try {
        started = await session.evaluate(confirmExpr);
      } catch (err) {
        // The popup closing mid-confirmation is terminal for this attempt - retrying against a
        // dead session just burns the whole budget and then reports the wrong reason.
        lastConfirmError = err;
        break;
      }
      if (started) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    if (!started) {
      // The popup's DOM is only ONE view of whether the capture began. The extension's own
      // activeStreams record in chrome.storage.local is the authoritative one, and it is what
      // the poll loop reconciles against everywhere else - so ask it before declaring failure.
      //
      // This is not a nicety. Observed live on NCNO 2027Q2: the capture started correctly, this
      // confirmation timed out reading the popup, the call was recorded as failed, and the
      // retry clicked Start a second time - which STOPPED the recording that was already
      // running. A false negative here does not merely mislabel a success, it destroys one.
      //
      // Reading storage opens an extension tab, which closes this popup. That is fine now: the
      // popup has done its job either way, and the session is closed first so nothing is
      // waiting on a socket that is about to die.
      session.close();
      const streams = await getActiveStreams(context, config).catch(() => null);
      if (streams && streamMatchesRow(streams, row)) {
        logger.warn(
          `Could not confirm "${expectedLabel}" from the popup, but the extension's own stream ` +
            'list shows it as active - treating the capture as started. Retrying would have ' +
            'stopped it.'
        );
        return;
      }
      const because = lastConfirmError ? `: ${lastConfirmError.message}` : '';
      throw new Error(`Clicked Start but could not confirm an active stream matching "${expectedLabel}"${because}`);
    }

    logger.info(`Extension started transcription for ${row.symbol} ${row.fiscalPeriod}`);
  } finally {
    session.close();
  }
}

module.exports = {
  // Exported for tests/diagnostics: it is pure inspection, no focus or capture side effects.
  assertPageLooksRelevant,
  // Exported so the exact command each platform runs can be asserted without running it. The
  // Windows form in particular is load-bearing and already working; adding the macOS branch
  // must not have perturbed it.
  buildShortcutCommand,
  triggerExtension,
  splitFiscalPeriod,
  getActiveStreams,
  streamMatchesRow,
};
