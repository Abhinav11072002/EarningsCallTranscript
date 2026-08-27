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
// Two modes, and the difference matters:
//
//   default   read-only. Navigates and follows entry clicks, but fills nothing and submits
//             nothing. Answers "can the matcher read this form?"
//
//   --fill    runs the REAL registration - fills the form with the dummy identity and submits
//             it, exactly as the watcher would. Answers the only question that counts: "would
//             this call have been recorded?"
//
// Read-only mode cannot answer that second question, and reporting as though it could is
// misleading: on most providers the player exists only AFTER registration, so a read-only pass
// stops at the gate and then reports that there is no player behind it. The first run of this
// tool did exactly that and called six healthy q4inc events "NO PLAYER".
//
// --fill submits real registrations to real providers under the dummy identity. That is what
// the watcher does on every call anyway, but it is not read-only and should not be run casually.
// It never triggers the extension and never records.
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
//   node scripts/diagnostics/diag-upcoming-forms.js 40 --fill  actually fill and submit
const { chromium } = require('playwright-core');
const { loadConfig } = require('../../src/loadConfig');
const { extractRows, minutesUntilCall } = require('../../src/tableWatcher');
const { getOrOpenPortalPage } = require('../../src/browserConnect');
const { resolveDialinLinkByClick } = require('../../src/dialinLinkClickResolver');
const { resolveWebcastPage } = require('../../src/webcastResolver');
const { advanceJoinFlow, describeJoinBlocker } = require('../../src/joinFlow');
const { inspectFields, fillRegistrationForm } = require('../../src/formFiller');
const { ensurePlaying, installAudioProbe } = require('../../src/playback');
const { rewriteToWebcastUrl, telephoneOnlyReason } = require('../../src/providerRules');
const { playerProbe } = require('../../src/pageRelevance');
const { splitFiscalPeriod } = require('../../src/extensionTrigger');

const limit = Number(process.argv.find((a) => /^\d+$/.test(a)) || 40);
const verbose = process.argv.includes('--verbose');
const fillMode = process.argv.includes('--fill');

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

    // A truncated link is not a link. The portal shows most of them shortened, and the full URL
    // has to be recovered by clicking the row; when that fails, testing what is left is worse
    // than testing nothing - it produces a confident verdict about a URL that never existed.
    //
    // Three of the four "remaining failures" in the first full run were exactly this. GTLB and
    // PATH were reported as ERR_NAME_NOT_RESOLVED, which was true of
    // "gitlab-second-quarter-fiscal-2027-financia..." because the HOSTNAME was cut in half.
    // GWRE reached Zoom's "Enter Meeting Info" because its pwd was chopped. Nothing was wrong
    // with any of the three.
    if (/(\.{3}|…)/.test(link)) {
      out.host = hostOf(link);
      out.verdict = 'UNRESOLVED';
      out.detail = `portal shows a shortened link and clicking the row did not recover it: ${link}`;
      return out;
    }

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

    if (fillMode) {
      // Exactly the sequence src/index.js runs, minus the extension trigger.
      const registration = await fillRegistrationForm(page, config.dummyIdentity, logger, undefined, { attempt: 1 });
      if (registration.page) page = registration.page;
      out.pending = Boolean(registration.pending);
      page = await advanceJoinFlow(page, logger);
      out.playback = await ensurePlaying(page, logger).catch(() => null);
    }

    out.host = hostOf(page.url());

    const blocker = await describeJoinBlocker(page).catch(() => null);
    // playerProbe runs IN the page - it reads document and location - so it is passed to
    // evaluate rather than called here. Calling it in Node throws "document is not defined",
    // which the catch below turned into an ERROR verdict for every single row.
    const probe = await page.evaluate(playerProbe).catch(() => null);
    const player = Boolean(probe && probe.hasPlayer);
    out.fields = await inspectFields(page).catch(() => []);

    const unmatched = out.fields.filter((f) => !f.matchedKey && f.type !== 'checkbox' && f.type !== 'radio');

    // In fill mode the gate is the headline: a form still standing after a real attempt is the
    // failure that costs calls, and it outranks anything the read-only checks noticed.
    // A row the portal has not scheduled can never be dispatched: index.js needs a countdown to
    // decide the 15-minute window, and without one the row is skipped. ECOR.L and ECOR.TO carry
    // "2026Q2" and no date, so testing them at all was measuring something production never
    // does - and reporting the result as a failure was worse than not testing them.
    if (minutesUntilCall(row) === null) {
      out.verdict = 'NO SCHEDULE';
      out.detail = `the portal gives no date or countdown (${JSON.stringify(String(row.transcriptionTimeText).slice(0, 30))})`;
      return out;
    }

    if (fillMode && out.pending) {
      out.verdict = 'GATE UP';
      out.detail = unmatched.length
        ? `unfilled: ${unmatched.map((f) => JSON.stringify(f.description.slice(0, 30))).join(', ')}`
        : 'every field filled and the gate is still there';
    } else if (fillMode && (player || (out.playback && out.playback.audible))) {
      out.verdict = 'JOINED';
      out.detail = out.playback ? out.playback.action : 'player present';
    } else if (unmatched.length && !fillMode) {
      // Only meaningful in read-only mode. Once a form has actually been submitted, GATE UP
      // above is the honest test: a field left unmatched that did NOT stop us is not a problem.
      // A site search box and a language selector were being reported as failures on calls that
      // had already been joined.
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
  // Only meaningful in fill mode, where playback is actually exercised - but harmless either
  // way, and it has to be installed before any page navigates. See playback.js.
  await installAudioProbe(context);
  const portalPage = await getOrOpenPortalPage(context, config.portalUrl);

  const all = await extractRows(portalPage);
  const withLinks = all.filter((r) => r.dialinLink && r.dialinLink !== '-');
  const rows = withLinks.slice(-limit);

  console.log('');
  console.log(`Portal shows ${all.length} row(s), ${withLinks.length} with a dial-in link. Rehearsing the last ${rows.length}.`);
  console.log(
    fillMode
      ? 'FILL MODE: forms will be filled and submitted for real. Nothing is recorded.'
      : 'Read-only: nothing is filled, submitted or recorded.'
  );
  console.log('='.repeat(104));

  // Truncated links have to be resolved by clicking the portal, which is a shared page - so
  // this stays strictly serial, exactly as the watcher does it.
  for (const row of rows) {
    if (/(\.{3}|…)/.test(row.dialinLink)) {
      // The truncated text identifies WHICH row to click, exactly as src/index.js does it.
      // Without it the resolver takes the first row carrying that symbol, and a table with
      // history in it holds many - which is why sixteen of fifty came back unresolved.
      const resolved = await resolveDialinLinkByClick(context, portalPage, row.symbol, logger, row.dialinLink)
        .catch(() => null);
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
  if (fillMode) {
    console.log(`  JOINED      ${by('JOINED').length}   registered and reached a player - would have recorded`);
    console.log(`  GATE UP     ${by('GATE UP').length}   the form was filled and the gate is STILL there - the real failures`);
  }
  console.log(`  OK          ${by('OK').length}   ${fillMode ? 'no gate, nothing to fill' : 'would be filled and joined'}`);
  console.log(`  FIELDS      ${by('FIELDS').length}   a field the matcher cannot identify - fix these first`);
  console.log(`  BLOCKED     ${by('BLOCKED').length}   a gate in the way (passcode, CAPTCHA, sign-in)`);
  console.log(`  NO PLAYER   ${by('NO PLAYER').length}   nothing to record, and the call is due - a real problem`);
  console.log(`  NOT LIVE    ${by('NOT LIVE').length}   no player yet, but the call is hours away - expected`);
  console.log(`  TELEPHONE   ${by('TELEPHONE').length}   known telephone-only, refused up front`);
  console.log(`  ERROR       ${by('ERROR').length}   did not load`);
  console.log(`  UNRESOLVED  ${by('UNRESOLVED').length}   the portal's link is shortened and could not be recovered`);
  console.log(`  NO SCHEDULE ${by('NO SCHEDULE').length}   no date in the portal, so the watcher would never dispatch it`);

  // Grouped, because one provider failing five times is one afternoon's work, not five.
  const hosts = new Map();
  // NOT LIVE is deliberately excluded: it is not evidence of anything.
  for (const r of results.filter((r) => ['GATE UP', 'FIELDS', 'BLOCKED', 'NO PLAYER', 'ERROR', 'UNRESOLVED'].includes(r.verdict))) {
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
