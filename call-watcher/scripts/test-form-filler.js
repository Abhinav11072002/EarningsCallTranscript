// Runs registration fixtures in the same already-running debug Chrome used by the watcher.
// Usage: npm run test:registration
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { fillRegistrationForm } = require('../src/formFiller');
const { loadConfig } = require('../src/loadConfig');

const config = loadConfig();

const fixtureDir = path.join(__dirname, '..', 'test', 'fixtures', 'registration');
const fixtures = ['zoom.html', 'q4.html', 'webcaster.html', 'choruscall.html', 'on24.html'];
const identity = config.dummyIdentity;
const logger = {
  info: (message) => console.log('[INFO]', message),
  warn: (message) => console.log('[WARN]', message),
};

async function fixtureSucceeded(page) {
  for (const frame of page.frames()) {
    if (await frame.getByText(/Registration complete|Registration completed|Thank you for registering|Registered for conference/).count()) {
      return true;
    }
  }
  return false;
}

async function allExpectedFieldsFilled(page, fixture) {
  const expected = fixture === 'choruscall.html'
    ? { full: identity.fullName, mail: identity.email, phone: identity.phone, org: identity.company }
    : fixture === 'webcaster.html'
      ? { givenName: identity.firstName, familyName: identity.lastName, contactEmail: identity.email, organization: identity.company }
      : fixture === 'q4.html'
        ? { q0: identity.firstName, q1: identity.lastName, q2: identity.company, q3: identity.email }
        : fixture === 'on24.html'
          ? { fn: identity.firstName, ln: identity.lastName, em: identity.email, co: identity.company }
      : { first: identity.firstName, last: identity.lastName, email: identity.email, company: identity.company };
  const values = {};
  for (const frame of page.frames()) {
    for (const [name, value] of Object.entries(expected)) {
      const field = frame.locator(`[name="${name}"], #${name}`).first();
      if (await field.count()) values[name] = await field.inputValue().catch(() => '');
    }
  }
  return Object.entries(expected).every(([name, value]) => values[name] === value);
}

(async () => {
  const browser = await chromium.connectOverCDP(config.cdpUrl);
  const context = browser.contexts()[0];
  const page = await context.newPage();
  page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));
  const failures = [];
  try {
    for (const fixture of fixtures) {
      await page.setContent(fs.readFileSync(path.join(fixtureDir, fixture), 'utf8'));
      const result = await fillRegistrationForm(page, identity, logger);
      const success = await fixtureSucceeded(page);
      const fieldsFilled = await allExpectedFieldsFilled(page, fixture);
      const passed = !result.pending && success && fieldsFilled;
      console.log(`${passed ? 'PASS' : 'FAIL'} ${fixture}: pending=${result.pending} success=${success} fields=${fieldsFilled}`);
      if (!passed) failures.push(fixture);
    }
    await page.setContent(fs.readFileSync(path.join(fixtureDir, 'rejected.html'), 'utf8'));
    const rejected = await fillRegistrationForm(page, identity, logger);
    const rejectedPassed = rejected.pending && rejected.error && await page.getByText(/not accepted/).count();
    console.log(`${rejectedPassed ? 'PASS' : 'FAIL'} rejected.html: pending=${rejected.pending} error=${Boolean(rejected.error)}`);
    if (!rejectedPassed) failures.push('rejected.html');
  } finally {
    await page.close();
    await browser.close();
  }
  if (failures.length) {
    console.error(`Registration fixtures failed: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log(`All ${fixtures.length} registration fixtures passed.`);
})().catch((error) => {
  console.error('Registration fixture test failed:', error);
  process.exit(1);
});
