// Standalone timing test for the extension-trigger step in isolation (bring tab to front ->
// send shortcut -> find popup via CDP -> fill -> click Start -> confirm stream). Doesn't touch
// the dedupe store, webcast resolution, or registration - just exercises the exact code path
// that timed out for ARAY, so we can measure whether a cold service worker now fits inside
// the (now 18s) popupTimeoutMs budget.
//
// For a meaningful test, the extension's service worker needs to actually be dormant first -
// avoid pressing Ctrl+Shift+Y or otherwise touching the extension for 30-60s before running
// this, otherwise it'll stay warm from that interaction and the test won't prove anything.
//
// Usage: node scripts/test-extension-trigger.js <SYMBOL> <YEAR> <PERIOD>
// e.g.:  node scripts/test-extension-trigger.js TEST 2026 Q1
const { chromium } = require('playwright-core');
const config = require('../config.json');
const { triggerExtension } = require('../src/extensionTrigger');

const [symbol, year, period] = process.argv.slice(2);
if (!symbol || !year || !period) {
  console.error('Usage: node scripts/test-extension-trigger.js <SYMBOL> <YEAR> <PERIOD>');
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
  const portalPage = context.pages().find((p) => p.url().includes('financialmodelingprep.com'));

  if (!portalPage) {
    console.error('Could not find the admin portal tab.');
    process.exit(1);
  }

  const row = { symbol, fiscalPeriod: `${year}${period}` };
  const start = Date.now();
  console.log(`Triggering extension for ${symbol} ${year}${period} (timing from now)...`);

  try {
    await triggerExtension(context, portalPage, row, config, logger);
    console.log(`SUCCESS in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } catch (err) {
    console.log(`FAILED after ${((Date.now() - start) / 1000).toFixed(1)}s: ${err.message}`);
    process.exit(1);
  }
})().catch((err) => {
  console.error('Test failed to run:', err.message);
  process.exit(1);
});
