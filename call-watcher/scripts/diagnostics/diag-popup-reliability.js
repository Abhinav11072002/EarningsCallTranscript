// DIAGNOSTIC - run by hand. Not part of `npm test`.
//
// Answers: "does the popup open and accept its values EVERY time, or only usually?"
//
// Reach for it after changing anything about focus or the keyboard shortcut. Repeats
// open-and-fill N times and reports the success rate and timings. This is how the foreground
// problem was measured: 0/30 before the ALT-tap fix, 30/30 after.
//
// Deliberately stops short of clicking Start, so it begins no capture and posts nothing to the
// backend - everything up to "the fields hold the right values" is what has to work every time.
//
// Usage: node scripts/diagnostics/diag-popup-reliability.js 10

const http = require('http');
const path = require('path');
const { execFile } = require('child_process');
const { chromium } = require('playwright-core');
const { loadConfig } = require('../../src/loadConfig');
const { splitFiscalPeriod } = require('../../src/extensionTrigger');

const config = loadConfig();
const iterations = Number(process.argv[2] || 10);
const SCRIPT = path.join(__dirname, '..', '..', 'src', 'send-shortcut.ps1');

const listTargets = () =>
  new Promise((resolve) => {
    const req = http.get(`${config.cdpUrl}/json/list`, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(d));
        } catch {
          resolve([]);
        }
      });
    });
    req.on('error', () => resolve([]));
    req.setTimeout(5000, () => req.destroy());
  });

function sendShortcut(titleHint) {
  return new Promise((resolve) => {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Port', new URL(config.cdpUrl).port, '-Keys', config.extensionShortcutSendKeys];
    if (titleHint) args.push('-TitleHint', titleHint);
    execFile('powershell.exe', args, { timeout: 30000 }, (err, stdout, stderr) => {
      // Keep only the meaningful sentence: PowerShell error records are huge and repetitive.
      const pick = (text) =>
        (text || '')
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find((l) => l && !l.startsWith('+') && !/^(CategoryInfo|FullyQualifiedErrorId)/.test(l)) || '';
      const detail = err
        ? pick(stderr).replace(/^.*send-shortcut\.ps1\s*:\s*/, '').slice(0, 160)
        : (stdout || '').trim().split(/\r?\n/).join(' | ');
      resolve({ ok: !err, detail });
    });
  });
}

function cdp(ws, id, method, params, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const settle = (fn, arg) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      ws.removeEventListener('message', onMsg);
      ws.removeEventListener('close', onClose);
      fn(arg);
    };
    const onMsg = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.id !== id) return;
      m.error ? settle(reject, new Error(m.error.message)) : settle(resolve, m.result);
    };
    const onClose = () => settle(reject, new Error('popup closed before replying'));
    const t = setTimeout(() => settle(reject, new Error(`${method} timed out`)), timeoutMs);
    ws.addEventListener('message', onMsg);
    ws.addEventListener('close', onClose);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

(async () => {
  const extId = config.extensionId;
  if (!extId) {
    console.error('Set extensionId in config.local.json first.');
    process.exit(1);
  }
  const browser = await chromium.connectOverCDP(config.cdpUrl, { timeout: 60000 });
  const context = browser.contexts()[0];

  // A scratch tab so nothing real is disturbed, and so the title hint is predictable.
  const target = await context.newPage();
  await target.setContent('<title>Popup Reliability Probe</title><h1>probe</h1>');
  await target.bringToFront();

  const results = [];
  for (let i = 1; i <= iterations; i++) {
    const symbol = `PROBE${i}`;
    const fiscalPeriod = '2026Q1';
    const { year, period } = splitFiscalPeriod(fiscalPeriod);
    const started = Date.now();
    let stage = 'focus/shortcut';
    try {
      await target.bringToFront();
      const shortcut = await sendShortcut(await target.title().catch(() => ''));
      if (!shortcut.ok) throw new Error(`shortcut failed: ${shortcut.detail}`);

      stage = 'find popup';
      const prefix = `chrome-extension://${extId}/popup.html`;
      const deadline = Date.now() + Number(config.popupTimeoutMs ?? 18000);
      let popup = null;
      while (Date.now() < deadline && !popup) {
        popup = (await listTargets()).find((t) => t.url && t.url.startsWith(prefix)) || null;
        if (!popup) await new Promise((r) => setTimeout(r, 150));
      }
      if (!popup) throw new Error('popup never appeared');

      stage = 'connect';
      const ws = new WebSocket(popup.webSocketDebuggerUrl);
      await new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('ws open timed out')), 10000);
        ws.addEventListener('open', () => { clearTimeout(t); res(); }, { once: true });
        ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('ws error')); }, { once: true });
      });
      let id = 1;
      await cdp(ws, id++, 'Runtime.enable', {});

      stage = 'fill';
      await cdp(ws, id++, 'Runtime.evaluate', {
        expression: `(function(){
          const s=document.getElementById('symbol'), y=document.getElementById('year'), p=document.getElementById('period');
          if(!s||!y||!p) return 'fields-not-found';
          s.value=${JSON.stringify(symbol)}; y.value=${JSON.stringify(year)}; p.value=${JSON.stringify(period)};
          [s,y,p].forEach(el=>el.dispatchEvent(new Event('input',{bubbles:true})));
          return 'ok';
        })()`,
        returnByValue: true,
      });

      stage = 'verify';
      const readBack = await cdp(ws, id++, 'Runtime.evaluate', {
        expression: `JSON.stringify({s:document.getElementById('symbol').value,y:document.getElementById('year').value,p:document.getElementById('period').value})`,
        returnByValue: true,
      });
      const got = JSON.parse(readBack.result.value);
      const correct = got.s === symbol && got.y === year && got.p === period;
      // Deliberately NOT clicking #start - see the header comment.
      ws.close();
      if (!correct) throw new Error(`fields wrong: ${JSON.stringify(got)}`);

      results.push({ i, ok: true, ms: Date.now() - started });
      console.log(`  ${String(i).padStart(2)}: OK   ${Date.now() - started}ms`);
    } catch (err) {
      results.push({ i, ok: false, ms: Date.now() - started, stage, error: err.message });
      console.log(`  ${String(i).padStart(2)}: FAIL ${Date.now() - started}ms  [${stage}] ${err.message}`);
    }
    // Let the popup close and the service worker settle between iterations.
    await new Promise((r) => setTimeout(r, 1200));
  }

  const ok = results.filter((r) => r.ok);
  const times = ok.map((r) => r.ms).sort((a, b) => a - b);
  console.log('');
  console.log(`success: ${ok.length}/${results.length}`);
  if (times.length) {
    console.log(`latency: min ${times[0]}ms  median ${times[Math.floor(times.length / 2)]}ms  max ${times[times.length - 1]}ms`);
  }
  for (const f of results.filter((r) => !r.ok)) console.log(`  failure at [${f.stage}]: ${f.error}`);

  await target.close().catch(() => {});
  await browser.close().catch(() => {});
  process.exit(ok.length === results.length ? 0 : 1);
})().catch((err) => {
  console.error('Harness failed:', err.message);
  process.exit(1);
});
