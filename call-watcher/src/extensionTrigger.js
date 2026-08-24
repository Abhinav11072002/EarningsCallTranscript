const { execFile } = require('child_process');
const path = require('path');
const http = require('http');
const { describeJoinBlocker } = require('./joinFlow');

const SEND_SHORTCUT_SCRIPT = path.join(__dirname, '..', 'scripts', 'send-shortcut.ps1');

const DEFAULT_SHORTCUT_TIMEOUT_MS = 30000;
const DEFAULT_CDP_COMMAND_TIMEOUT_MS = 10000;
const DEFAULT_POPUP_TIMEOUT_MS = 18000;
const DEFAULT_STREAM_CONFIRM_TIMEOUT_MS = 8000;

// Sends the extension's keyboard shortcut via scripts/send-shortcut.ps1, which finds the
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
    const port = new URL(config.cdpUrl).port;
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SEND_SHORTCUT_SCRIPT, '-Port', port, '-Keys', sendKeysSequence];
    if (titleHint) args.push('-TitleHint', titleHint);
    const timeout = Number(config.shortcutTimeoutMs ?? DEFAULT_SHORTCUT_TIMEOUT_MS);
    execFile('powershell.exe', args, { timeout }, (err, stdout, stderr) => {
      // Collapsed to one line on purpose: the logger writes one entry per call, so an embedded
      // newline produces continuation lines with no timestamp - which log rotation cannot
      // attribute to a time and therefore never prunes.
      const out = (stdout || '').trim().split(/\r?\n/).filter(Boolean).join(' | ');
      if (out) logger.info(`send-shortcut.ps1: ${out}`);
      if (err) {
        // PowerShell error records are enormous (the message, then CategoryInfo and
        // FullyQualifiedErrorId, often duplicated). Keep just the human sentence so the log
        // line and the outcomes ledger stay readable.
        const firstSentence = (stderr || '')
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find((l) => l && !l.startsWith('+') && !/^(CategoryInfo|FullyQualifiedErrorId)/.test(l));
        const detail = (firstSentence || '').replace(/^.*send-shortcut\.ps1\s*:\s*/, '').trim();
        const reason = err.killed ? `timed out after ${timeout}ms` : detail || err.message;
        reject(new Error(`Focus/keystroke injection failed: ${reason}`));
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
// Deliberately permissive: it looks for the ticker root OR a quarter token anywhere in the
// title/URL/visible text, and only refuses when it finds NOTHING relevant. A false refusal
// costs one retry and a loud log line; a false accept costs the transcript.
async function assertPageLooksRelevant(page, row, logger, config, dialinUrl) {
  const { year, period } = splitFiscalPeriod(row.fiscalPeriod);
  const symbolRoot = String(row.symbol || '')
    .split(/[.\-^]/)[0]
    .toLowerCase();

  const probe = await page
    .evaluate(() => ({
      title: document.title || '',
      url: location.href,
      text: (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 4000),
      hasMedia: Boolean(document.querySelector('video, audio, [class*=player], [id*=player], iframe')),
    }))
    .catch(() => null);
  if (!probe) return; // cannot inspect; the other guards still apply

  const haystack = `${probe.title} ${probe.url} ${probe.text}`.toLowerCase();
  const symbolMatch = Boolean(symbolRoot && symbolRoot.length >= 2 && haystack.includes(symbolRoot));
  const yearMatch = Boolean(year && haystack.includes(String(year)));
  const periodMatch = Boolean(period && haystack.includes(String(period).toLowerCase()));

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

  // The year ALONE is far too weak - almost any page mentions the current year (the admin portal
  // itself does, which is how an earlier, looser version of this check passed on a page that had
  // nothing to do with the call). Accept only a genuine identifier: the ticker, or the quarter
  // AND year together, or a player element accompanied by one of them.
  // The portal's own dial-in link is authoritative: if we are still on the host it pointed at,
  // no resolution decision was made that could have gone wrong, and there is nothing for this
  // check to catch. Observed live on NSSC 2026Q4 - app.webinar.net serves a player whose title
  // is just "webinar.net" and whose visible text names neither the ticker nor the quarter, so
  // the identity tiers below refused it on every retry until the call was gone. A false accept
  // costs one transcript; a false refusal costs the call itself, and the call does not repeat.
  // The bad-title, replay and pre-join checks above still apply, so a dead or wrong-state page
  // on the right host is still refused.
  let sameHostAsDialin = false;
  try {
    if (dialinUrl) sameHostAsDialin = new URL(probe.url).hostname === new URL(dialinUrl).hostname;
  } catch {
    sameHostAsDialin = false;
  }

  const accepted = symbolMatch
    ? `symbol "${symbolRoot}"`
    : yearMatch && periodMatch
      ? `${period} ${year}`
      : probe.hasMedia && (yearMatch || periodMatch)
        ? `a player element plus ${periodMatch ? period : year}`
        : sameHostAsDialin
          ? `it being the dial-in link the portal gave us (${new URL(probe.url).hostname})`
          : null;

  if (!accepted) {
    const message =
      `page does not identifiably belong to ${row.symbol} ${row.fiscalPeriod} ` +
      `(title "${probe.title}", url ${probe.url}) - resolution probably landed on the wrong page`;
    // Escapable without a code change: if a legitimate minimal player page (one that names
    // neither the company nor the quarter) ever trips this, set requirePageRelevance=false in
    // config.local.json to downgrade it to a warning rather than editing the check out.
    if (config && config.requirePageRelevance === false) {
      logger.warn(`Relevance check would have refused this page, but is disabled: ${message}`);
      return;
    }
    throw new Error(`Refusing to record: ${message}`);
  }
  logger.info(`Target page relevance check passed on ${accepted}.`);
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
  triggerExtension,
  splitFiscalPeriod,
  getActiveStreams,
  streamMatchesRow,
};
