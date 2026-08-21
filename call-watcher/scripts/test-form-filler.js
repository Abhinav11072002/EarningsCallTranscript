// Runs registration fixtures in the same already-running debug Chrome used by the watcher.
// Usage: npm run test:registration
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { fillRegistrationForm } = require('../src/formFiller');
const { loadConfig } = require('../src/loadConfig');

const config = loadConfig();

const fixtureDir = path.join(__dirname, '..', 'test', 'fixtures', 'registration');
// Auto-discovered rather than hardcoded, so a fixture captured via
// `npm run capture:registration <provider>` is covered without editing this file.
// "rejected*" fixtures are negative cases (the gate is expected to REMAIN pending) and are
// asserted separately below, so they are excluded from the positive set.
// Three fixture categories, distinguished by filename prefix:
//   (default)  a real gate that should be filled and submitted -> pending false
//   rejected*  a gate that the provider REJECTS -> pending true, with an error surfaced
//   nogate*    no gate at all, but the page carries furniture that looks like one (a footer
//              newsletter box, a header "Sign In") -> pending must be false, and the unrelated
//              inputs must be left alone. Treating these as a gate fails a call that was fine.
const NEGATIVE_FIXTURE_PREFIX = 'rejected';
const NOGATE_FIXTURE_PREFIX = 'nogate';
const allFixtures = fs.readdirSync(fixtureDir).filter((name) => name.endsWith('.html')).sort();
const fixtures = allFixtures.filter(
  (name) => !name.startsWith(NEGATIVE_FIXTURE_PREFIX) && !name.startsWith(NOGATE_FIXTURE_PREFIX)
);
const nogateFixtures = allFixtures.filter((name) => name.startsWith(NOGATE_FIXTURE_PREFIX));
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

    // No-gate fixtures: the call is already joinable. Reporting pending here would fail a
    // perfectly good call, and filling an unrelated input can trigger navigation or an
    // autocomplete overlay on top of the player.
    for (const fixture of nogateFixtures) {
      await page.setContent(fs.readFileSync(path.join(fixtureDir, fixture), 'utf8'));
      const result = await fillRegistrationForm(page, identity, logger);
      const strayValues = await page.evaluate((dummy) => {
        const dirty = [];
        for (const el of document.querySelectorAll('input')) {
          if (el.value && Object.values(dummy).some((v) => String(el.value).trim() === String(v).trim())) {
            dirty.push(el.name || el.id || el.type);
          }
        }
        return dirty;
      }, identity);
      const passed = !result.pending && strayValues.length === 0;
      console.log(
        `${passed ? 'PASS' : 'FAIL'} ${fixture}: pending=${result.pending} strayFilled=${JSON.stringify(strayValues)}`
      );
      if (!passed) failures.push(fixture);
    }
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
