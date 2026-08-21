const { execFile } = require('child_process');
const path = require('path');
const http = require('http');

const SEND_SHORTCUT_SCRIPT = path.join(__dirname, '..', 'scripts', 'send-shortcut.ps1');

// Sends the extension's keyboard shortcut via scripts/send-shortcut.ps1, which finds the
// exact chrome.exe process matching --remote-debugging-port (unambiguous, unlike matching by
// window title when the user's regular Chrome is also open) and forces real OS-level
// foreground focus onto it before sending the keys. Plain CDP page.bringToFront() alone isn't
// enough here - it doesn't reliably grant true OS foreground focus, and chrome.action.openPopup()
// fails with "Could not find an active browser window" without it.
// This is the one step that must be a real, trusted OS-level gesture: the extension's
// getDisplayMedia() capture relies on Chrome's activeTab grant, which only follows a
// genuine user gesture invoking the extension (see manifest/background.js changes).
function sendGlobalShortcut(sendKeysSequence, cdpUrl, titleHint, logger) {
  return new Promise((resolve, reject) => {
    const port = new URL(cdpUrl).port;
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SEND_SHORTCUT_SCRIPT, '-Port', port, '-Keys', sendKeysSequence];
    if (titleHint) args.push('-TitleHint', titleHint);
    execFile('powershell.exe', args, (err, stdout, stderr) => {
      if (stdout && stdout.trim()) logger.info(`send-shortcut.ps1 output:\n${stdout.trim()}`);
      if (err) reject(new Error(`Failed to send shortcut via PowerShell: ${err.message} ${stderr || ''}`));
      else resolve();
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
      'Set "extensionId" in config.json manually (copy it from chrome://extensions).'
  );
}

async function hasActiveStream(context, config, row) {
  const extensionId = await getExtensionId(context, config);
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    return await page.evaluate(({ symbol, fiscalPeriod }) => {
      const match = /^(\d{4})(.*)$/.exec((fiscalPeriod || '').trim());
      const year = match ? match[1] : '';
      const period = match ? match[2].trim() : '';
      return new Promise((resolve) => {
        chrome.storage.local.get(['activeStreams'], ({ activeStreams = [] }) => {
          resolve(activeStreams.some((stream) =>
            stream.symbol === symbol && stream.year === year && stream.period === period
          ));
        });
      });
    }, { symbol: row.symbol, fiscalPeriod: row.fiscalPeriod });
  } finally {
    await page.close();
  }
}

// Confirmed by direct testing (scripts/diagnose-popup.js): the popup opens visibly and is
// listed by Chrome's own /json/list HTTP endpoint, but Playwright's context.pages()/'page'
// event NEVER sees it - its auto-attach mechanism doesn't reach this target, most likely
// because it isn't spawned as a child of any target Playwright already tracks. So the popup
// is found and driven entirely through a raw CDP connection instead of Playwright's Page API.
function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on('error', reject);
  });
}

async function findPopupTarget(cdpUrl, extensionId, timeoutMs) {
  const targetPrefix = `chrome-extension://${extensionId}/popup.html`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await httpGetJson(`${cdpUrl}/json/list`).catch(() => []);
    const match = targets.find((t) => t.url && t.url.startsWith(targetPrefix));
    if (match) return match;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Timed out waiting for the extension popup to open (shortcut may not have reached Chrome)');
}

function sendCdpCommand(ws, id, method, params) {
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== id) return;
      ws.removeEventListener('message', onMessage);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

// Opens a raw CDP WebSocket session directly to the popup's own target and exposes a small
// evaluate() helper - this runs JS in the popup's page context, same as if popup.js itself
// had done it. That's fine for filling fields/clicking Start: those don't need to be "trusted"
// user actions themselves, unlike the earlier getDisplayMedia() call, whose activeTab grant
// was already satisfied by the real keypress that opened this popup in the first place.
async function openCdpSession(webSocketDebuggerUrl) {
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('WebSocket error connecting to popup CDP target')), { once: true });
  });
  let nextId = 1;
  const send = (method, params) => sendCdpCommand(ws, nextId++, method, params);
  await send('Runtime.enable', {});
  return {
    evaluate: async (expression) => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) {
        throw new Error(`Popup script error: ${result.exceptionDetails.text || JSON.stringify(result.exceptionDetails)}`);
      }
      return result.result ? result.result.value : undefined;
    },
    close: () => ws.close(),
  };
}

function splitFiscalPeriod(fiscalPeriod) {
  const m = /^(\d{4})(.*)$/.exec((fiscalPeriod || '').trim());
  if (m) return { year: m[1], period: m[2].trim() };
  return { year: '', period: fiscalPeriod || '' };
}

// Brings the call tab to front, triggers the popup via the global shortcut, then finds and
// drives it via raw CDP (Symbol/Year/Period + Start Transcription).
async function triggerExtension(context, targetPage, row, config, logger) {
  const extensionId = await getExtensionId(context, config);

  await targetPage.bringToFront();
  const titleHint = await targetPage.title().catch(() => '');
  await sendGlobalShortcut(config.extensionShortcutSendKeys, config.cdpUrl, titleHint, logger);

  const popupTarget = await findPopupTarget(config.cdpUrl, extensionId, config.popupTimeoutMs || 8000);
  logger.info(`Found popup target via CDP: ${popupTarget.id}`);

  const session = await openCdpSession(popupTarget.webSocketDebuggerUrl);
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
    const deadline = Date.now() + 8000;
    let started = false;
    while (Date.now() < deadline) {
      started = await session.evaluate(confirmExpr).catch(() => false);
      if (started) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    if (!started) throw new Error(`Clicked Start but no active stream matching "${expectedLabel}" appeared in the popup`);

    logger.info(`Extension started transcription for ${row.symbol} ${row.fiscalPeriod}`);
  } finally {
    session.close();
  }
}

module.exports = { triggerExtension, splitFiscalPeriod, hasActiveStream };
