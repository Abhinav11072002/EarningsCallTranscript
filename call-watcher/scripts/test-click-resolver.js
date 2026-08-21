// Standalone test: exercises ONLY resolveDialinLinkByClick for one symbol, without touching
// the dedupe store, registration, or extension pipeline. Usage:
//   node scripts/test-click-resolver.js BULL
const { chromium } = require('playwright-core');
const { loadConfig } = require('../src/loadConfig');

const config = loadConfig();
const { resolveDialinLinkByClick } = require('../src/dialinLinkClickResolver');

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
  const resolved = await resolveDialinLinkByClick(context, portalPage, symbol, logger);
  console.log('RESULT:', resolved);
})().catch((err) => {
  console.error('Test failed:', err.message);
  process.exit(1);
});
