// Browser-free unit tests for the pure logic: time parsing, dedupe keys, the retry state
// machine, log retention, and config merging.
//
// Everything else in this project needs the live debug Chrome, which meant the subtlest code
// here had no coverage at all - the time parser (three formats, DST-sensitive) and the retry
// state machine (which silently had its attempt cap disabled) were both entirely untested.
// This suite runs anywhere in about a second, so it can be run before every commit.
//
// Usage: npm run test:unit
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseCountdownToMinutes, minutesUntilCall, rowKey } = require('../src/tableWatcher');
const { StateStore } = require('../src/stateStore');
const { resolveLogPath, pruneOldLogFiles } = require('../src/logRotation');
const { splitFiscalPeriod, streamMatchesRow } = require('../src/extensionTrigger');
const { createObservability } = require('../src/observability');
const {
  zoomWebClientUrl,
  NATIVE_APP_PATTERN,
  BROWSER_ENTRY_PATTERN,
  PRE_JOIN_TEXT_PATTERN,
  TERMINAL_STATE_PATTERN,
  LEGITIMATE_WAIT_PATTERN,
} = require('../src/joinFlow');

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
  }
}
const approx = (got, want, tol = 0.02) => assert.ok(Math.abs(got - want) < tol, `expected ~${want}, got ${got}`);

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------- countdown parsing

check('countdown: real formats seen in the portal', () => {
  approx(parseCountdownToMinutes('9 min 7 sec'), 9.1167);
  approx(parseCountdownToMinutes('44 min 30 sec'), 44.5);
  approx(parseCountdownToMinutes('1 hrs 25 min 35 sec'), 85.5833);
  approx(parseCountdownToMinutes('2 days 5 hrs 14 min 30 sec'), 3194.5);
  approx(parseCountdownToMinutes('3 hrs'), 180);
  approx(parseCountdownToMinutes('  44 min 30 sec  '), 44.5);
});

// This is the regression that matters most: the geometry scrape can hand us a wrapper element
// carrying a whole row's concatenated text. The old unit-scavenging parser turned that into a
// confident 1397 (the hrs pattern taking "23" out of "2026Q23") instead of the true 197, and
// because it "succeeded" nothing warned - the call was just silently skipped as out-of-window.
check('countdown: rejects concatenated row text instead of mis-parsing it', () => {
  assert.strictEqual(parseCountdownToMinutes('2026-08-19AAPL2026Q23 hrs 17 min 19 sec https://x'), null);
  assert.strictEqual(parseCountdownToMinutes('AAPL2026Q23 hrs'), null);
});

check('countdown: rejects non-countdown text', () => {
  for (const bad of ['', null, undefined, '2026Q2', '2', 'Symbol', '2026 Aug 27 - 09:00:00 AM', '3:17:19']) {
    assert.strictEqual(parseCountdownToMinutes(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------------- absolute date-time parsing

check('absolute date-time: parsed as America/New_York, DST-aware', () => {
  // Both are 09:00 local New York; only the UTC offset differs (EDT -4 vs EST -5). Comparing
  // the derived instants is what catches a hardcoded offset, which would be wrong half the year.
  // Tolerance because minutesUntilCall reads its own clock, a few ms after the one here.
  const assertInstant = (text, expectedIso) => {
    const derived = Date.now() + minutesUntilCall({ transcriptionTimeText: text }) * 60000;
    const drift = Math.abs(derived - Date.parse(expectedIso));
    assert.ok(drift < 2000, `${text}: derived ${new Date(derived).toISOString()}, expected ~${expectedIso}`);
  };
  assertInstant('2026 Jul 15 - 09:00:00 AM', '2026-07-15T13:00:00.000Z'); // EDT, UTC-4
  assertInstant('2026 Jan 15 - 09:00:00 AM', '2026-01-15T14:00:00.000Z'); // EST, UTC-5
  // 24-hour values appear in this column despite the AM/PM suffix, so the suffix is ignored.
  assertInstant('2026 Aug 11 - 16:30:00 PM', '2026-08-11T20:30:00.000Z');
});

check('absolute date-time: past dates come back negative', () => {
  assert.ok(minutesUntilCall({ transcriptionTimeText: '2020 Jan 01 - 09:00:00 AM' }) < 0);
});

check('minutesUntilCall: falls through countdown -> absolute -> null', () => {
  approx(minutesUntilCall({ transcriptionTimeText: '44 min 30 sec' }), 44.5);
  assert.ok(minutesUntilCall({ transcriptionTimeText: '2026 Aug 27 - 09:00:00 AM' }) !== null);
  assert.strictEqual(minutesUntilCall({ transcriptionTimeText: '2026Q2' }), null);
});

// ---------------------------------------------------------------- keys and period splitting

check('rowKey: distinguishes same ticker across periods and dates', () => {
  const base = { symbol: 'ACME', fiscalPeriod: '2026Q2', earningsDate: '2026-08-21' };
  assert.notStrictEqual(rowKey(base), rowKey({ ...base, fiscalPeriod: '2026Q3' }));
  assert.notStrictEqual(rowKey(base), rowKey({ ...base, earningsDate: '2026-08-22' }));
  assert.strictEqual(rowKey(base), rowKey({ ...base }));
});

check('splitFiscalPeriod: splits normally and degrades predictably', () => {
  assert.deepStrictEqual(splitFiscalPeriod('2026Q2'), { year: '2026', period: 'Q2' });
  assert.deepStrictEqual(splitFiscalPeriod(' 2027Q1 '), { year: '2027', period: 'Q1' });
  assert.deepStrictEqual(splitFiscalPeriod('FY26'), { year: '', period: 'FY26' });
});

// The write path (triggerExtension) and the read path (the poll loop's reconciliation) must
// agree on unsplittable periods. When they disagreed, a successful start could never be
// matched afterwards, so every poll saw it as inactive and started a duplicate recording.
check('streamMatchesRow: read path agrees with the write path', () => {
  const row = { symbol: 'ACME', fiscalPeriod: '2026Q2' };
  const { year, period } = splitFiscalPeriod(row.fiscalPeriod);
  assert.strictEqual(streamMatchesRow([{ symbol: 'ACME', year, period }], row), true);
  assert.strictEqual(streamMatchesRow([{ symbol: 'OTHER', year, period }], row), false);
  assert.strictEqual(streamMatchesRow([], row), false);
  assert.strictEqual(streamMatchesRow(null, row), false);

  const odd = { symbol: 'ACME', fiscalPeriod: 'FY26' };
  const split = splitFiscalPeriod(odd.fiscalPeriod);
  assert.strictEqual(streamMatchesRow([{ symbol: 'ACME', year: split.year, period: split.period }], odd), true);
});

// ---------------------------------------------------------------- retry state machine

check('StateStore: attempts increment so the cap can actually engage', () => {
  const dir = tmpDir('cw-state-');
  const store = new StateStore(path.join(dir, 'processed.json'));
  const key = 'ACME|2026Q2|2026-08-21';
  const maxAttempts = 4;

  const seen = [];
  for (let i = 0; i < 6; i++) {
    const record = store.get(key);
    if (record && (!store.retryDue(key) || record.attempts >= maxAttempts)) {
      seen.push('capped');
      continue;
    }
    // Mirrors the poll loop: claim WITHOUT removing first, so history is preserved.
    seen.push(store.claim(key).attempts);
    store.fail(key, 'boom', -1000); // negative delay => immediately retry-due
  }
  assert.deepStrictEqual(seen, [1, 2, 3, 4, 'capped', 'capped']);
  fs.rmSync(dir, { recursive: true, force: true });
});

check('StateStore: removing before claiming resets attempts (the bug this guards)', () => {
  const dir = tmpDir('cw-state2-');
  const store = new StateStore(path.join(dir, 'processed.json'));
  const key = 'K';
  store.claim(key);
  store.fail(key, 'boom', -1000);
  store.remove(key);
  assert.strictEqual(store.claim(key).attempts, 1, 'claim after remove must restart the series');
  fs.rmSync(dir, { recursive: true, force: true });
});

check('StateStore: retryDue honours backoff, and started records are not retry-due', () => {
  const dir = tmpDir('cw-state3-');
  const store = new StateStore(path.join(dir, 'processed.json'));
  const key = 'K';
  assert.strictEqual(store.retryDue(key), true, 'unknown key is actionable');
  store.claim(key);
  store.fail(key, 'boom', 60000);
  assert.strictEqual(store.retryDue(key), false, 'still inside backoff');
  store.fail(key, 'boom', -1000);
  assert.strictEqual(store.retryDue(key), true, 'backoff elapsed');
  store.markStarted(key);
  assert.strictEqual(store.retryDue(key), false, 'started is not a retry candidate');
  fs.rmSync(dir, { recursive: true, force: true });
});

check('StateStore: legacy array format migrates to started records', () => {
  const dir = tmpDir('cw-state4-');
  const file = path.join(dir, 'processed.json');
  fs.writeFileSync(file, JSON.stringify(['ACME|2026Q2|2026-08-19']));
  const store = new StateStore(file);
  const migrated = store.get('ACME|2026Q2|2026-08-19');
  assert.strictEqual(migrated.status, 'started');
  assert.strictEqual(migrated.attempts, 1);
  // Stamped on migration so the TTL sweep ages it out instead of deleting it immediately.
  assert.ok(migrated.updatedAt && !Number.isNaN(Date.parse(migrated.updatedAt)));
  fs.rmSync(dir, { recursive: true, force: true });
});

check('StateStore: survives a corrupt state file rather than throwing', () => {
  const dir = tmpDir('cw-state5-');
  const file = path.join(dir, 'processed.json');
  fs.writeFileSync(file, '{ this is not json');
  const store = new StateStore(file);
  assert.strictEqual(store.get('anything'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- terminal completion + TTL

check('StateStore: completed is terminal and distinguishable from failed', () => {
  const dir = tmpDir('cw-done-');
  const store = new StateStore(path.join(dir, 'processed.json'));
  const key = 'K';
  store.claim(key);
  store.markStarted(key);
  store.markCompleted(key, 'stream ended past the reacquire grace period');
  const rec = store.get(key);
  assert.strictEqual(rec.status, 'completed');
  assert.ok(rec.completedReason);
  // Terminal means the poll loop skips it outright, so it must never look retry-due.
  assert.strictEqual(store.retryDue(key), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

check('StateStore: expired records are pruned, fresh ones kept', () => {
  const dir = tmpDir('cw-ttl-');
  const file = path.join(dir, 'processed.json');
  const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const recent = new Date().toISOString();
  fs.writeFileSync(
    file,
    JSON.stringify({
      'OLD|2026Q1|2026-01-01': { status: 'completed', attempts: 1, updatedAt: old },
      'NEW|2026Q2|2026-08-21': { status: 'started', attempts: 1, updatedAt: recent },
    })
  );
  const store = new StateStore(file, 7); // constructor prunes on load
  assert.strictEqual(store.get('OLD|2026Q1|2026-01-01'), null, 'stale record should be gone');
  assert.ok(store.get('NEW|2026Q2|2026-08-21'), 'recent record should survive');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- call tab lifecycle

check('CallTabRegistry: closes finished calls and ages out the rest', () => {
  const { CallTabRegistry } = require('../src/callTabs');
  const closed = [];
  const fakePage = (name) => ({
    isClosed: () => false,
    close: () => {
      closed.push(name);
      return Promise.resolve();
    },
  });
  const reg = new CallTabRegistry({ info: () => {}, warn: () => {} });
  reg.register('done', fakePage('done'), 'DONE 2026Q1');
  reg.register('live', fakePage('live'), 'LIVE 2026Q1');
  assert.strictEqual(reg.size(), 2);

  // Only the completed one closes; a huge age cap means nothing ages out.
  reg.sweep((k) => k === 'done', 60 * 60 * 1000);
  assert.deepStrictEqual(closed, ['done']);
  assert.strictEqual(reg.size(), 1);

  // Age cap of 0 closes whatever is left, even though it is not "finished".
  reg.sweep(() => false, -1);
  assert.deepStrictEqual(closed.sort(), ['done', 'live']);
  assert.strictEqual(reg.size(), 0);
});

check('CallTabRegistry: re-registering a key does not leak the previous tab', () => {
  const { CallTabRegistry } = require('../src/callTabs');
  const closed = [];
  const fakePage = (name) => ({ isClosed: () => false, close: () => { closed.push(name); return Promise.resolve(); } });
  const reg = new CallTabRegistry({ info: () => {}, warn: () => {} });
  reg.register('k', fakePage('first'), 'X');
  reg.register('k', fakePage('second'), 'X');
  assert.deepStrictEqual(closed, ['first']);
  assert.strictEqual(reg.size(), 1);
});

check('CallTabRegistry: drops tabs the user already closed', () => {
  const { CallTabRegistry } = require('../src/callTabs');
  const reg = new CallTabRegistry({ info: () => {}, warn: () => {} });
  reg.register('gone', { isClosed: () => true, close: () => Promise.resolve() }, 'GONE');
  reg.sweep(() => false, 60 * 60 * 1000);
  assert.strictEqual(reg.size(), 0);
});

// ---------------------------------------------------------------- log retention

check('logRotation: path rolls over by local day', () => {
  const a = resolveLogPath('/logs', new Date(2026, 7, 21, 23, 59));
  const b = resolveLogPath('/logs', new Date(2026, 7, 22, 0, 1));
  assert.ok(a.endsWith('call-watcher-2026-08-21.log'), a);
  assert.ok(b.endsWith('call-watcher-2026-08-22.log'), b);
});

check('logRotation: deletes only day-files past the horizon', () => {
  const dir = tmpDir('cw-logs-');
  const now = new Date(2026, 7, 21);
  const mk = (name) => fs.writeFileSync(path.join(dir, name), 'x');
  mk('call-watcher-2026-08-21.log'); // today
  mk('call-watcher-2026-08-20.log'); // yesterday
  mk('call-watcher-2026-08-01.log'); // 20 days old
  mk('call-watcher.log');            // legacy name, not dated
  mk('outcomes-2026-08-01.jsonl');   // ledger must never be pruned

  const removed = pruneOldLogFiles(dir, 14, now);
  assert.deepStrictEqual(removed, ['call-watcher-2026-08-01.log']);
  const left = fs.readdirSync(dir).sort();
  assert.deepStrictEqual(left, [
    'call-watcher-2026-08-20.log',
    'call-watcher-2026-08-21.log',
    'call-watcher.log',
    'outcomes-2026-08-01.jsonl',
  ]);
  fs.rmSync(dir, { recursive: true, force: true });
});

check('logRotation: missing directory is not an error', () => {
  assert.deepStrictEqual(pruneOldLogFiles(path.join(os.tmpdir(), 'cw-does-not-exist-xyz'), 14), []);
});

// ---------------------------------------------------------------- observability

// The shutdown summary is the one artifact an operator reads after leaving this running all
// day, and it is produced on a code path that only executes at exit - so it was shipped
// broken: on a day with no recorded calls, summarize() took its "no ledger file" branch,
// which returned an object literal missing `retriedThenStarted`, and the shutdown handler's
// `.retriedThenStarted.length` threw. Observed live as "Could not produce the daily summary:
// Cannot read properties of undefined (reading 'length')". These assert the SHAPE, not just
// the counts, on both branches - that is what the bug was.
const SUMMARY_KEYS = ['date', 'total', 'started', 'failed', 'retriedThenStarted', 'skippedLate'];

function withTempObs(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-obs-'));
  const quiet = { info() {}, warn() {}, error() {} };
  try {
    return fn(createObservability(dir, quiet), dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

check('observability: summary of an empty day has every field an operator prints', () => {
  withTempObs((obs) => {
    const s = obs.summarize();
    assert.deepStrictEqual(Object.keys(s).sort(), [...SUMMARY_KEYS].sort());
    for (const k of ['started', 'failed', 'retriedThenStarted', 'skippedLate']) {
      assert.ok(Array.isArray(s[k]), `${k} must be an array, got ${typeof s[k]}`);
    }
    assert.strictEqual(s.total, 0);
  });
});

check('observability: shutdown summary block runs without throwing on an empty day', () => {
  withTempObs((obs) => {
    // Exercises the exact expressions in the SIGINT handler in src/index.js.
    const s = obs.summarize();
    const line = `started=${s.started.length}, failed=${s.failed.length}, ` +
      `skipped-late=${s.skippedLate.length}, recovered-on-retry=${s.retriedThenStarted.length}`;
    assert.strictEqual(line, 'started=0, failed=0, skipped-late=0, recovered-on-retry=0');
    s.failed.forEach((f) => String(f.error));
    s.skippedLate.forEach((x) => String(x.minsPastStart));
    s.started.filter((x) => (x.lateBySec ?? 0) > 60).forEach((x) => String(x.label));
  });
});

check('observability: a call that failed then started is reported once, as recovered', () => {
  withTempObs((obs) => {
    obs.recordOutcome({ status: 'failed', symbol: 'AAPL', fiscalPeriod: '2026Q2', error: 'boom' });
    obs.recordOutcome({ status: 'started', symbol: 'AAPL', fiscalPeriod: '2026Q2', secondsLateVsScheduled: 12 });
    obs.recordOutcome({ status: 'failed', symbol: 'MSFT', fiscalPeriod: '2026Q2', error: 'no link' });
    obs.recordOutcome({ status: 'skipped-late', symbol: 'TSLA', fiscalPeriod: '2026Q2', minsPastStart: 40 });

    const s = obs.summarize();
    assert.deepStrictEqual(Object.keys(s).sort(), [...SUMMARY_KEYS].sort());
    assert.strictEqual(s.total, 4);
    assert.deepStrictEqual(s.started.map((x) => x.label), ['AAPL 2026Q2']);
    assert.deepStrictEqual(s.failed.map((x) => x.label), ['MSFT 2026Q2'], 'AAPL must not be listed as failed');
    assert.deepStrictEqual(s.retriedThenStarted, ['AAPL 2026Q2']);
    assert.deepStrictEqual(s.skippedLate.map((x) => x.label), ['TSLA 2026Q2']);
  });
});

check('observability: a corrupt ledger line is skipped, not fatal', () => {
  withTempObs((obs, dir) => {
    obs.recordOutcome({ status: 'started', symbol: 'NVDA', fiscalPeriod: '2026Q2' });
    const led = fs.readdirSync(dir).find((f) => f.startsWith('outcomes-'));
    fs.appendFileSync(path.join(dir, led), '{not json' + String.fromCharCode(10));
    const s = obs.summarize();
    assert.strictEqual(s.started.length, 1);
    assert.strictEqual(s.total, 2, 'total counts raw lines, including the unparseable one');
  });
});

// ---------------------------------------------------------------- join flow

// NSCIF 2026Q2 (2026-08-24) recorded 20 minutes of a Zoom LOBBY page: two buttons, no fields,
// so the form filler saw no gate and the pipeline started capture where it stood. These cover
// the three decisions that failure turned on.

check('joinFlow: the app button that broke the call is now unclickable', () => {
  // This is the regression. formFiller scores a button on the bare word "join", so
  // "Join from Zoom Workplace app" was a valid CTA - and clicking it raises an OS dialog that
  // takes the foreground the extension keystroke needs moments later.
  assert.ok(NATIVE_APP_PATTERN.test('Join from Zoom Workplace app'));
  assert.ok(/join/i.test('Join from Zoom Workplace app'), 'sanity: it does match the CTA word');
  for (const text of ['Launch Meeting', 'Download Now', 'Open Zoom', 'Install the app', 'Join from the app']) {
    assert.ok(NATIVE_APP_PATTERN.test(text), `should be blocked: ${text}`);
  }
});

check('joinFlow: the browser option is not mistaken for the app option', () => {
  for (const text of ['Join from browser', 'Join from your browser', 'Continue in browser', 'Use web client']) {
    assert.ok(BROWSER_ENTRY_PATTERN.test(text), `should be an entry CTA: ${text}`);
    assert.ok(!NATIVE_APP_PATTERN.test(text), `must not be blocked as native: ${text}`);
  }
  // Ordinary CTAs must not be dragged into either bucket.
  for (const text of ['Join', 'Register for webinar', 'Submit', 'Listen to the webcast', 'Enter event']) {
    assert.ok(!NATIVE_APP_PATTERN.test(text), `must stay clickable: ${text}`);
    assert.ok(!BROWSER_ENTRY_PATTERN.test(text), `not a browser-entry CTA: ${text}`);
  }
});

check('joinFlow: zoom lobby URLs map to the web client, others map to nothing', () => {
  assert.strictEqual(
    zoomWebClientUrl('https://us02web.zoom.us/j/83171321596?pwd=qpoCCe0T8xBEsZvO4Tn5bwnQk33BxL.1#success'),
    'https://app.zoom.us/wc/83171321596/join?pwd=qpoCCe0T8xBEsZvO4Tn5bwnQk33BxL.1'
  );
  assert.strictEqual(zoomWebClientUrl('https://zoom.us/w/98765432100'), 'https://app.zoom.us/wc/98765432100/join');
  // Already on the web client: returning a URL here would make advanceJoinFlow loop.
  assert.strictEqual(zoomWebClientUrl('https://app.zoom.us/wc/83171321596/join?pwd=x'), null);
  // Not Zoom, or not a join path - never guess a URL shape.
  assert.strictEqual(zoomWebClientUrl('https://notzoom.us/j/83171321596'), null);
  assert.strictEqual(zoomWebClientUrl('https://us02web.zoom.us/rec/play/abc'), null);
  assert.strictEqual(zoomWebClientUrl('https://edge.media-server.com/mmc/p/abc'), null);
  assert.strictEqual(zoomWebClientUrl('not a url'), null);
});

check('joinFlow: pre-join wording is recognised from page text alone', () => {
  // What the relevance guard keys on when the interstitial has no real <button>.
  for (const text of ['Join from browser', 'Enter Meeting Info', 'Launch Meeting', "Don't have the Zoom Workplace app installed?"]) {
    assert.ok(PRE_JOIN_TEXT_PATTERN.test(text), `should read as pre-join: ${text}`);
  }
  // An in-call page must not trip it, or every Zoom call would be refused.
  for (const text of ['Mute Stop Video Participants Chat', 'Waiting for the host to start this meeting']) {
    assert.ok(!PRE_JOIN_TEXT_PATTERN.test(text), `must not read as pre-join: ${text}`);
  }
});

check('joinFlow: a finished call is recognised as finished', () => {
  for (const text of [
    'This meeting has ended',
    'The webcast has concluded. A replay will be available shortly.',
    'This event has been cancelled',
    'The video is no longer available',
    'This conference call is over',
  ]) {
    assert.ok(TERMINAL_STATE_PATTERN.test(text), `should read as over: ${text}`);
  }
});

check('joinFlow: wording that appears beside a LIVE stream never refuses it', () => {
  // The asymmetry that drives this list: a false refusal loses the call outright, and the call
  // does not happen twice. Each of these can legitimately sit on a page whose audio is playing.
  for (const text of [
    'Registration is closed',                     // routine once a call has started
    'Thank you for attending',                    // can be pre-set copy on the player page
    'A replay will be available after the call',  // a promise about later, not a state now
    'Q2 2026 Earnings Call',
    'Mute Stop Video Participants Chat Leave',
    'The webcast will begin shortly. Please wait.',
    'Waiting for the host to start this meeting',
  ]) {
    assert.ok(!TERMINAL_STATE_PATTERN.test(text), `must NOT refuse: ${text}`);
  }
});

check('joinFlow: healthy pre-call waiting is recognised as healthy', () => {
  for (const text of [
    'Waiting for the host to start this meeting',
    'The webcast will begin shortly',
    'The meeting has not started yet',
    'Please wait, you are in the waiting room',
  ]) {
    assert.ok(LEGITIMATE_WAIT_PATTERN.test(text), `should read as a healthy wait: ${text}`);
    // The two must not overlap, or joining early would be refused as "already over".
    assert.ok(!TERMINAL_STATE_PATTERN.test(text), `waiting must not also read as over: ${text}`);
  }
});

// ---------------------------------------------------------------- report

for (const f of failures) console.error(`FAIL ${f}`);
console.log(`${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
