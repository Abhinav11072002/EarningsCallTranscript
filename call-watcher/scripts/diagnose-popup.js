// Standalone diagnostic: connects to the debug Chrome instance and reports every page
// Playwright detects, via both the 'page' event and by polling context.pages(). Run this,
// then manually press the extension's shortcut (or click its icon) and watch the output -
// this tells us definitively whether Playwright's page-tracking sees the popup at all, since
// extension action popups can be a different kind of CDP target than a regular tab.
const { chromium } = require('playwright-core');
const config = require('../config.json');

(async () => {
  const browser = await chromium.connectOverCDP(config.cdpUrl);
  const context = browser.contexts()[0];

  context.on('page', (page) => {
    console.log(`[page event] url="${page.url()}"`);
    page.on('load', () => console.log(`[page event -> loaded] url="${page.url()}"`));
  });

  console.log('Connected. Listening for new pages - press the extension shortcut/icon now.');
  console.log('Current pages at startup:');
  for (const p of context.pages()) console.log(`  - ${p.url()}`);

  setInterval(() => {
    const urls = context.pages().map((p) => p.url());
    console.log(`[poll] ${urls.length} page(s): ${JSON.stringify(urls)}`);
  }, 1000);
})().catch((err) => {
  console.error('Diagnostic script failed:', err);
  process.exit(1);
});
