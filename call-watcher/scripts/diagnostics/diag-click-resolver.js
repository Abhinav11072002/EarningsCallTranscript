// DIAGNOSTIC - run by hand. Not part of `npm test`.
//
// Answers: "what URL does the portal actually open for this symbol?"
//
// Reach for it when a call fails with a link that looks wrong or truncated. Exercises ONLY
// resolveDialinLinkByClick against the live table - no dedupe store, no registration, no
// extension - so it is safe to run repeatedly and starts no recording.
//
// Usage: node scripts/diagnostics/diag-click-resolver.js BEEM

const { chromium } = require('playwright-core');
const { loadConfig } = require('../../src/loadConfig');

const config = loadConfig();
const { resolveDialinLinkByClick } = require('../../src/dialinLinkClickResolver');

const symbol = process.argv[2];
if (!symbol) {
  console.error('Usage: node scripts/test-click-resolver.js <SYMBOL>');
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

  console.log(`Resolving truncated dial-in link for ${symbol}...`);
  try {
    const resolved = await resolveDialinLinkByClick(context, portalPage, symbol, logger);
    console.log('RESULT:', resolved);
  } finally {
    // Without this the open CDP connection keeps the event loop alive and the script hangs,
    // leaving a stray node process behind. (Safe on connectOverCDP - transport only.)
    await browser.close().catch(() => {});
  }
  process.exit(0);
})().catch((err) => {
  console.error('Test failed:', err.message);
  process.exit(1);
});
