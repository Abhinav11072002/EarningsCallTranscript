// DIAGNOSTIC - run by hand. Not part of `npm test`.
//
// Answers: "what does the form filler actually SEE on this page, and what would it type where?"
//
// Reach for it whenever a registration fails and the error is unhelpful - "This field is
// required", "Company name required". Reading the form the way the matcher reads it takes a
// minute; inferring the cause from an error message costs far more, and is usually wrong.
//
// It found both halves of the q4inc failure in one run: an id of "analyst-last-name" matching
// nothing because the pattern required whitespace rather than a hyphen, and the geometric label
// guess then handing that field its neighbour's "First name" - so the last-name box was being
// filled with the first name.
//
// Read-only: it fills nothing, clicks nothing and submits nothing.
//
// Usage: node scripts/diagnostics/diag-form-fields.js <url>
const { chromium } = require('playwright-core');
const { loadConfig } = require('../../src/loadConfig');
const { inspectFields } = require('../../src/formFiller');

const url = process.argv[2];
if (!url) {
  console.error('usage: node scripts/diagnostics/diag-form-fields.js <url>');
  process.exit(1);
}

(async () => {
  const config = loadConfig();
  const browser = await chromium.connectOverCDP(config.cdpUrl);
  const page = await browser.contexts()[0].newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Registration forms are routinely client-rendered; an immediate read finds an empty page.
    await page.waitForTimeout(5000);

    console.log(`\ntitle: ${await page.title()}`);
    console.log(`url  : ${page.url()}\n`);

    const rows = await inspectFields(page);
    if (!rows.length) {
      console.log('No visible fields found. If the page needs a moment longer, or the form is');
      console.log('behind a click, this will legitimately come back empty.');
      return;
    }

    console.log('field                      would receive        what the matcher reads');
    console.log('-'.repeat(100));
    for (const row of rows) {
      const value = row.matchedKey ? config.dummyIdentity[row.matchedKey] : '(nothing)';
      const flag = row.matchedKey ? ' ' : '!';
      console.log(
        `${flag} ${row.type.padEnd(10)} ${String(row.matchedKey || '-- no match --').padEnd(14)} ` +
          `${JSON.stringify(value).padEnd(18)} ${JSON.stringify(row.description).slice(0, 46)}`
      );
    }
    console.log('-'.repeat(100));
    const unmatched = rows.filter((r) => !r.matchedKey && r.type !== 'checkbox');
    console.log(
      unmatched.length
        ? `\n${unmatched.length} field(s) marked ! would be left empty. If the form requires one of them, that is the failure.`
        : '\nEvery field would be filled.'
    );
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
})().catch((err) => {
  console.error('diagnostic failed:', err.message);
  process.exit(1);
});
