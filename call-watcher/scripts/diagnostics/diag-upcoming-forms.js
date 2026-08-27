// DIAGNOSTIC - run by hand. Not part of `npm test`.
//
// A REHEARSAL. Takes the calls currently listed in the portal, walks each one as far as the
// registration form, and reports what the matcher would do with it - without filling anything,
// submitting anything, or recording anything.
//
// It exists because every failure this project has fixed was discovered the same way: after the
// call, from a ledger entry, when nothing could be done about it. The information needed to
// predict the failure was on the provider's page days earlier. This reads it early, so a form
// that cannot be completed is a task in the morning rather than a lost call at 09:00.
//
// What it will NOT do: fill a field, tick a box, or press a submit button. It navigates and, on
// pages whose form sits behind an entry click, follows that - the same steps the watcher takes
// before it ever types anything.
//
// WHEN to run it: on the morning of the calls, not days ahead. A provider page for an event
// that has not started yet legitimately has no player, and several show an outright error until
// they go live - event.choruscall.com serves a page titled "Error", viavid serves "ERROR -
// Problem with current viewing session". Run days early, those look like broken pages and bury
// the real findings. Rows more than NOT_LIVE_YET_MINUTES away are therefore reported separately
// rather than counted as failures.
//
// Usage:
//   node scripts/diagnostics/diag-upcoming-forms.js            last 40 rows with a link
//   node scripts/diagnostics/diag-upcoming-forms.js 15         last 15
//   node scripts/diagnostics/diag-upcoming-forms.js 40 --all   include rows already recorded
const { chromium } = require('playwright-core');
const { loadConfig } = require('../../src/loadConfig');
const { extractRows, minutesUntilCall } = require('../../src/tableWatcher');
const { getOrOpenPortalPage } = require('../../src/browserConnect');
const { resolveDialinLinkByClick } = require('../../src/dialinLinkClickResolver');
const { resolveWebcastPage } = require('../../src/webcastResolver');
const { advanceJoinFlow, describeJoinBlocker } = require('../../src/joinFlow');
const { inspectFields } = require('../../src/formFiller');
const { rewriteToWebcastUrl, telephoneOnlyReason } = require('../../src/providerRules');
const { playerProbe } = require('../../src/pageRelevance');
const { splitFiscalPeriod } = require('../../src/extensionTrigger');

const limit = Number(process.argv.find((a) => /^\d+$/.test(a)) || 40);
const verbose = process.argv.includes('--verbose');

const logger = {
  info: (m) => verbose && console.log('        [INFO]', m),
  warn: (m) => verbose && console.log('        [WARN]', m),
};

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '(unparseable)';
  }
}

// One row's verdict, in the order the pipeline would reach each conclusion.
// Beyond this, a page with no player tells us nothing: the event has not started.
const NOT_LIVE_YET_MINUTES = 120;

async function rehearse(context, row, config) {
  const out = { key: `${row.symbol} ${row.fiscalPeriod}`, host: null, verdict: null, detail: '', fields: [] };
  let page = null;

  try {
    let link = row.dialinLink;

    const phoneOnly = telephoneOnlyReason(link);
    if (phoneOnly) {
      out.host = hostOf(link);
      out.verdict = 'TELEPHONE';
      out.detail = phoneOnly;
      return out;
    }

    const rewritten = rewriteToWebcastUrl(link);
    if (rewritten.changed) {
      out.detail = `rewritten to ${rewritten.url}`;
      link = rewritten.url;
    }
    out.host = hostOf(link);

    const { year, period } = splitFiscalPeriod(row.fiscalPeriod);
    page = await resolveWebcastPage(context, link, config, logger, {
      symbol: row.symbol,
      year,
      period,
      attempt: 1,
    });
    page = await advanceJoinFlow(page, logger);
    out.host = hostOf(page.url());

    const blocker = await describeJoinBlocker(page).catch(() => null);
    // playerProbe runs IN the page - it reads document and location - so it is passed to
    // evaluate rather than called here. Calling it in Node throws "document is not defined",
    // which the catch below turned into an ERROR verdict for every single row.
    const probe = await page.evaluate(playerProbe).catch(() => null);
    const player = Boolean(probe && probe.hasPlayer);
    out.fields = await inspectFields(page).catch(() => []);

    const unmatched = out.fields.filter((f) => !f.matchedKey && f.type !== 'checkbox' && f.type !== 'radio');

    if (unmatched.length) {
      out.verdict = 'FIELDS';
      out.detail = unmatched.map((f) => JSON.stringify(f.description.slice(0, 34))).join(', ');
    } else if (blocker) {
      out.verdict = 'BLOCKED';
      out.detail = blocker.slice(0, 90);
    } else if (!player && !out.fields.length) {
      // Nothing to fill and nothing to play. Before the event starts that is the normal state
      // of most provider pages, and saying so is the difference between a checklist worth
      // acting on and forty rows of noise.
      const minsLeft = minutesUntilCall(row);
      const notYet = minsLeft === null || minsLeft > NOT_LIVE_YET_MINUTES;
      out.verdict = notYet ? 'NOT LIVE' : 'NO PLAYER';
      out.detail =
        `title ${JSON.stringify(((probe && probe.title) || '').slice(0, 50))}` +
        (minsLeft === null ? '' : `, ${Math.round(minsLeft)} min away`);
    } else {
      out.verdict = 'OK';
      out.detail = out.fields.length ? `${out.fields.length} field(s), all matched` : 'player present, no gate';
    }
  } catch (err) {
    out.verdict = 'ERROR';
    out.detail = err.message.slice(0, 90);
  } finally {
    if (page) await page.close().catch(() => {});
  }
  return out;
}

(async () => {
  const config = loadConfig();
  const browser = await chromium.connectOverCDP(config.cdpUrl);
  const context = browser.contexts()[0];
  const portalPage = await getOrOpenPortalPage(context, config.portalUrl);

  const all = await extractRows(portalPage);
  const withLinks = all.filter((r) => r.dialinLink && r.dialinLink !== '-');
  const rows = withLinks.slice(-limit);

  console.log('');
  console.log(`Portal shows ${all.length} row(s), ${withLinks.length} with a dial-in link. Rehearsing the last ${rows.length}.`);
  console.log('Nothing is filled, submitted or recorded.');
  console.log('='.repeat(104));

  // Truncated links have to be resolved by clicking the portal, which is a shared page - so
  // this stays strictly serial, exactly as the watcher does it.
  for (const row of rows) {
    if (/(\.{3}|…)/.test(row.dialinLink)) {
      const resolved = await resolveDialinLinkByClick(context, portalPage, row.symbol, logger).catch(() => null);
      if (resolved) row.dialinLink = resolved;
    }
  }

  const results = [];
  for (const [index, row] of rows.entries()) {
    process.stdout.write(`[${String(index + 1).padStart(2)}/${rows.length}] ${`${row.symbol} ${row.fiscalPeriod}`.padEnd(20)}`);
    const result = await rehearse(context, row, config);
    results.push(result);
    console.log(`${result.verdict.padEnd(10)} ${result.host || ''}`);
    if (result.detail && result.verdict !== 'OK') console.log(`${''.padEnd(31)}${result.detail}`);
  }

  await browser.close().catch(() => {});

  const by = (v) => results.filter((r) => r.verdict === v);
  console.log('');
  console.log('='.repeat(104));
  console.log(`  OK          ${by('OK').length}   would be filled and joined`);
  console.log(`  FIELDS      ${by('FIELDS').length}   a field the matcher cannot identify - fix these first`);
  console.log(`  BLOCKED     ${by('BLOCKED').length}   a gate in the way (passcode, CAPTCHA, sign-in)`);
  console.log(`  NO PLAYER   ${by('NO PLAYER').length}   nothing to record, and the call is due - a real problem`);
  console.log(`  NOT LIVE    ${by('NOT LIVE').length}   no player yet, but the call is hours away - expected`);
  console.log(`  TELEPHONE   ${by('TELEPHONE').length}   known telephone-only, refused up front`);
  console.log(`  ERROR       ${by('ERROR').length}   did not load`);

  // Grouped, because one provider failing five times is one afternoon's work, not five.
  const hosts = new Map();
  // NOT LIVE is deliberately excluded: it is not evidence of anything.
  for (const r of results.filter((r) => ['FIELDS', 'BLOCKED', 'NO PLAYER', 'ERROR'].includes(r.verdict))) {
    if (!hosts.has(r.host)) hosts.set(r.host, []);
    hosts.get(r.host).push(r.key);
  }
  if (hosts.size) {
    console.log('');
    console.log('PROVIDERS TO LOOK AT, worst first');
    console.log('-'.repeat(104));
    for (const [host, keys] of [...hosts.entries()].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  ${String(keys.length).padStart(3)}  ${String(host).padEnd(38)} ${keys.join(', ').slice(0, 55)}`);
    }
  }
  console.log('');
})().catch((err) => {
  console.error('rehearsal failed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
