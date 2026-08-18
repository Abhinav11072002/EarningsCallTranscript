const { chromium } = require('playwright-core');

async function connectToChrome(cdpUrl) {
  let browser;
  try {
    browser = await chromium.connectOverCDP(cdpUrl);
  } catch (err) {
    throw new Error(
      `Could not connect to Chrome at ${cdpUrl}. Make sure Chrome was launched with ` +
        `--remote-debugging-port=... (see README.md). Original error: ${err.message}`
    );
  }
  const contexts = browser.contexts();
  if (!contexts.length) {
    throw new Error('Connected to Chrome, but found no browser contexts (no windows open?).');
  }
  return { browser, context: contexts[0] };
}

async function getOrOpenPortalPage(context, portalUrl) {
  const target = new URL(portalUrl);
  const existing = context.pages().find((p) => {
    try {
      return new URL(p.url()).origin === target.origin;
    } catch {
      return false;
    }
  });
  if (existing) {
    if (existing.url() !== portalUrl) {
      await existing.goto(portalUrl, { waitUntil: 'domcontentloaded' });
    }
    return existing;
  }
  const page = await context.newPage();
  await page.goto(portalUrl, { waitUntil: 'domcontentloaded' });
  return page;
}

module.exports = { connectToChrome, getOrOpenPortalPage };
