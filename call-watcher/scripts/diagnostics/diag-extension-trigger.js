// DIAGNOSTIC - run by hand. Not part of `npm test`.
//
// Answers: "is the popup path itself working, and how long does it take?"
//
// Reach for it when captures stop starting and you need to know whether the fault is in
// finding the call or in triggering the extension. Runs the trigger step alone - bring tab to
// front, send the shortcut, find the popup over CDP, fill it, click Start, confirm the stream -
// skipping resolution and registration entirely.
//
// The target defaults to the PORTAL tab, which is wrong for an end-to-end rehearsal: the portal
// has no player, so the relevance guard refuses before the keystroke is ever sent. Name the tab
// you actually want with --tab=<substring of its URL>.
//
// WARNING: this one DOES start a real transcription, so it posts to the live backend. Use a
// throwaway symbol and stop the stream afterwards.
//
// Usage: node scripts/diagnostics/diag-extension-trigger.js TEST 2026 Q1
//        node scripts/diagnostics/diag-extension-trigger.js TEST 2026 Q1 --tab=trigger-test.html

const { chromium } = require('playwright-core');
const { loadConfig } = require('../../src/loadConfig');

const config = loadConfig();
const { triggerExtension } = require('../../src/extensionTrigger');

const args = process.argv.slice(2);
const tabFlag = args.find((a) => a.startsWith('--tab='));
const tabMatch = tabFlag ? tabFlag.slice('--tab='.length) : 'financialmodelingprep.com';
const [symbol, year, period] = args.filter((a) => !a.startsWith('--'));
if (!symbol || !year || !period) {
  console.error(
    'Usage: node scripts/diagnostics/diag-extension-trigger.js <SYMBOL> <YEAR> <PERIOD> [--tab=<url substring>]'
  );
  process.exit(1);
}

const logger = {
  info: (m) => console.log('[INFO]', m),
  warn: (m) => console.log('[WARN]', m),
  error: (m) => console.log('[ERROR]', m),
};

(async () => {
  const browser = await chromium.connectOverCDP(config.cdpUrl);
  const context = browser.contexts()[0];
  context.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));
  const targetPage = context.pages().find((p) => p.url().includes(tabMatch));

  if (!targetPage) {
    console.error(`Could not find a tab whose URL contains "${tabMatch}". Open tabs:`);
    for (const p of context.pages()) console.error(`  ${p.url()}`);
    process.exit(1);
  }
  console.log(`Target tab: ${targetPage.url()}`);

  const row = { symbol, fiscalPeriod: `${year}${period}` };
  const start = Date.now();
  console.log(`Triggering extension for ${symbol} ${year}${period} (timing from now)...`);

  let failed = false;
  try {
    await triggerExtension(context, targetPage, row, config, logger);
    console.log(`SUCCESS in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } catch (err) {
    console.log(`FAILED after ${((Date.now() - start) / 1000).toFixed(1)}s: ${err.message}`);
    failed = true;
  } finally {
    // Disconnect explicitly: the open CDP connection keeps the event loop alive, so without
    // this the script hangs after finishing and leaves a node process holding the connection.
    // (Safe on connectOverCDP - it closes the transport, not the operator's Chrome.)
    await browser.close().catch(() => {});
  }
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('Test failed to run:', err.message);
  process.exit(1);
});
