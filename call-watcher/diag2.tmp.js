const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { loadConfig } = require('./src/loadConfig');
const { fillRegistrationForm } = require('./src/formFiller');

const config = loadConfig();
(async () => {
  const browser = await chromium.connectOverCDP(config.cdpUrl, { timeout: 60000 });
  const page = await browser.contexts()[0].newPage();
  await page.setContent(fs.readFileSync(path.join('test/fixtures/registration', 'multistep-two-screens.html'), 'utf8'));
  const logger = { info: (m) => console.log('[INFO]', m), warn: (m) => console.log('[WARN]', m) };
  const result = await fillRegistrationForm(page, config.dummyIdentity, logger);
  console.log('result:', JSON.stringify(result));
  const after = await page.evaluate(() => ({
    visibleInputs: [...document.querySelectorAll('input')].filter((e) => e.getBoundingClientRect().height > 0).map((e) => e.id),
    visibleButtons: [...document.querySelectorAll('button')].filter((e) => e.getBoundingClientRect().height > 0).map((e) => e.innerText.trim()),
    step1Hidden: document.getElementById('step1').hidden,
    step2Hidden: document.getElementById('step2').hidden,
    resultShown: !document.getElementById('result').hidden,
  }));
  console.log('page after:', JSON.stringify(after, null, 2));
  await page.close(); await browser.close(); process.exit(0);
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
