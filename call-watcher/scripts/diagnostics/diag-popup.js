// DIAGNOSTIC - run by hand. Not part of `npm test`.
//
// Answers: "does Playwright see the extension popup at all?"
//
// Reach for it if the popup opens on screen but the watcher reports it timed out. Connects to
// the debug Chrome and reports every page Playwright detects, via both the 'page' event and by
// polling context.pages(). Run it, then press the extension shortcut yourself and watch.
//
// This is the script that settled the question originally: the popup IS listed by Chrome's own
// /json/list endpoint but Playwright's page-tracking never sees it, which is why the popup is
// driven over a raw CDP WebSocket instead of the Page API.
//
// Usage: node scripts/diagnostics/diag-popup.js

const { chromium } = require('playwright-core');
const { loadConfig } = require('../../src/loadConfig');

const config = loadConfig();

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
