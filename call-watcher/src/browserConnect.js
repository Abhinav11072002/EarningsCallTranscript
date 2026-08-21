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
  const context = contexts[0];
  // Chrome can report an alert after the extension has already dismissed it. Handle dialogs
  // centrally and tolerate that CDP race so a transient extension alert cannot kill the watcher.
  context.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));
  return { browser, context };
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
    await selectInCallView(existing);
    return existing;
  }
  const page = await context.newPage();
  await page.goto(portalUrl, { waitUntil: 'domcontentloaded' });
  await selectInCallView(page);
  return page;
}

async function selectInCallView(page) {
  const tab = page.getByRole('button', { name: 'In Call View', exact: true });
  if (!(await tab.count())) return;
  await tab.click();
  await page.waitForTimeout(250);
}

module.exports = { connectToChrome, getOrOpenPortalPage };
