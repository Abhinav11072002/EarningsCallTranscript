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

const { parseCountdownToMinutes, minutesUntilCall, rowKey, stampDueAt, minutesRemaining } = require('../../src/tableWatcher');
const { StateStore } = require('../../src/stateStore');
const { shouldSkipAsLate, shouldReacquireNow, retryDelayMsFor } = require('../../src/dispatchRules');
const { rewriteToWebcastUrl, telephoneOnlyReason, notAWebcastReason } = require('../../src/providerRules');
const { shardIndexFor, ownsRow, readShard, describeShard } = require('../../src/shard');
const { isProviderNonContentPath, isFurniturePath } = require('../../src/webcastResolver');
const { mapWithConcurrency, Mutex, withDeadline, runPreparedBatch } = require('../../src/concurrency');
const { resolveLogPath, pruneOldLogFiles } = require('../../src/logRotation');
const { splitFiscalPeriod, streamMatchesRow, buildShortcutCommand } = require('../../src/extensionTrigger');
const { createObservability } = require('../../src/observability');
const { SeenLog, reconcile, formatReconciliation } = require('../../src/reconciliation');
const { blindReason } = require('../../src/supervisorRules');
const { matchField } = require('../../src/formFiller');
const { validateConfig } = require('../../src/validateConfig');
const { judgeRelevance, driftedWithinHost, symbolAppearsAsWord } = require('../../src/pageRelevance');
const { strategyForAttempt, BASE } = require('../../src/retryStrategy');
const { parseSendKeys, toAppleScriptModifiers, toAppleScriptArgs, describeShortcut } = require('../../src/shortcutKeys');
const { macCommand, windowsCommand } = require('../../src/preflight');
const { acquireInstanceLock, releaseInstanceLock, refreshInstanceLock, lockPathFor } = require('../../src/instanceLock');
const { loadConfig } = require('../../src/loadConfig');
const {
  zoomWebClientUrl,
  NATIVE_APP_PATTERN,
  BROWSER_ENTRY_PATTERN,
  PRE_JOIN_TEXT_PATTERN,
  TERMINAL_STATE_PATTERN,
  LEGITIMATE_WAIT_PATTERN,
} = require('../../src/joinFlow');

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
const asyncChecks = [];
function checkAsync(name, fn) {
  asyncChecks.push({ name, fn });
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

// A tab is only closable when we KNOW it is not recording; helper keeps the cases readable.
function tabHarness() {
  const { CallTabRegistry } = require('../../src/callTabs');
  const closed = [];
  const page = (name) => ({
    isClosed: () => false,
    close: () => {
      closed.push(name);
      return Promise.resolve();
    },
  });
  const registry = new CallTabRegistry({ info: () => {}, warn: () => {} });
  const sweep = (options) =>
    registry.sweep({
      isFinished: () => false,
      isRecording: () => null,
      softMaxAgeMs: 90 * 60000,
      hardMaxAgeMs: 180 * 60000,
      endedGraceMs: 20 * 60000,
      pastStartMaxMs: 90 * 60000,
      ...options,
    });
  return { registry, closed, page, sweep };
}

check('CallTabRegistry: a finished call closes at once', () => {
  const { registry, closed, page, sweep } = tabHarness();
  registry.register('done', page('done'), 'DONE 2026Q1');
  registry.register('live', page('live'), 'LIVE 2026Q1');
  sweep({ isFinished: (k) => k === 'done' });
  assert.deepStrictEqual(closed, ['done']);
  assert.strictEqual(registry.size(), 1);
});

check('CallTabRegistry: a tab that is STILL RECORDING is never closed, at any age', () => {
  // The whole point. The tab is the recording, so closing one mid-capture does not mislabel a
  // success - it destroys it. An earnings call with a long Q&A can outlast any sensible cap,
  // and the old age check fired regardless of what was happening inside the tab.
  const { registry, closed, page, sweep } = tabHarness();
  // Forty minutes into the call: well inside the ninety-minute limit below, so the only things
  // that could close it here are the age caps - and they must not.
  registry.register('live', page('live'), 'LIVE 2026Q1', Date.now() - 40 * 60000);
  for (let poll = 0; poll < 5; poll++) {
    sweep({ isRecording: () => true, softMaxAgeMs: -1, hardMaxAgeMs: -1, endedGraceMs: -1 });
  }
  assert.deepStrictEqual(closed, [], 'a live capture must survive every age cap');
  assert.strictEqual(registry.size(), 1);
});

check('CallTabRegistry: "could not check" is never read as "not recording"', () => {
  // One unreadable stream list would otherwise close every open capture at once.
  const { registry, closed, page, sweep } = tabHarness();
  registry.register('live', page('live'), 'LIVE 2026Q1', Date.now() - 60 * 60000);
  for (let poll = 0; poll < 5; poll++) sweep({ isRecording: () => null });
  assert.deepStrictEqual(closed, [], 'blind polls must not close anything inside the hard cap');

  // The hard cap is the fallback for a machine that can never read the list at all.
  sweep({ isRecording: () => null, hardMaxAgeMs: -1 });
  assert.deepStrictEqual(closed, ['live']);
});

check('CallTabRegistry: a stopped tab closes once the call is past its start, after confirmation', () => {
  const { registry, closed, page, sweep } = tabHarness();
  // Opened 15 minutes before a call that started 40 minutes ago.
  registry.register('over', page('over'), 'OVER 2026Q1', Date.now() - 40 * 60000);

  sweep({ isRecording: () => false });
  assert.deepStrictEqual(closed, [], 'one observation is not enough - a blip must not kill a tab');

  sweep({ isRecording: () => false });
  assert.deepStrictEqual(closed, ['over'], 'two consecutive confirmations close it');
});

check('CallTabRegistry: a blip resets the confirmation count', () => {
  // false, then true, then false must NOT close: only consecutive observations count.
  const { registry, closed, page, sweep } = tabHarness();
  registry.register('flap', page('flap'), 'FLAP 2026Q1', Date.now() - 40 * 60000);
  sweep({ isRecording: () => false });
  sweep({ isRecording: () => true });
  sweep({ isRecording: () => false });
  assert.deepStrictEqual(closed, [], 'the streak restarts after any poll that saw it recording');
  sweep({ isRecording: () => false });
  assert.deepStrictEqual(closed, ['flap']);
});

check('CallTabRegistry: a stopped tab for a call that has NOT started yet is left alone', () => {
  // Captures start up to fifteen minutes early and are silent until someone speaks, so "not
  // recording" before the call is ordinary. Closing there would throw away a correctly joined
  // tab minutes before the call it was waiting for.
  const { registry, closed, page, sweep } = tabHarness();
  registry.register('early', page('early'), 'EARLY 2026Q1', Date.now() + 10 * 60000);
  for (let poll = 0; poll < 4; poll++) sweep({ isRecording: () => false });
  assert.deepStrictEqual(closed, [], 'a tab for a call still in the future must stay open');
});

check('CallTabRegistry: hasPendingDecisions only asks for the stream list when it matters', () => {
  // Reading the list opens an extension tab, so it must not happen every poll for tabs that are
  // obviously still live.
  const { registry, page } = tabHarness();
  registry.register('early', page('early'), 'EARLY 2026Q1', Date.now() + 30 * 60000);
  assert.strictEqual(registry.hasPendingDecisions(20 * 60000, 90 * 60000), false);

  registry.register('over', page('over'), 'OVER 2026Q1', Date.now() - 40 * 60000);
  assert.strictEqual(registry.hasPendingDecisions(20 * 60000, 90 * 60000), true);
});

check('CallTabRegistry: a row with no scheduled time still ages out once stopped', () => {
  // dueAt is null when the portal gave no date. The soft cap is all that is left.
  const { registry, closed, page, sweep } = tabHarness();
  registry.register('undated', page('undated'), 'UNDATED 2026Q1', null);
  sweep({ isRecording: () => false });
  sweep({ isRecording: () => false });
  assert.deepStrictEqual(closed, [], 'inside the soft cap it stays');
  sweep({ isRecording: () => false, softMaxAgeMs: -1 });
  assert.deepStrictEqual(closed, ['undated']);
});

check('CallTabRegistry: a tab is closed 90 minutes past the call start even mid-recording', () => {
  // The one rule that outranks "never interrupt a capture". An earnings call does not run
  // ninety minutes past its scheduled start, so a tab still capturing then is recording
  // something else - a lobby, a replay loop, a page whose audio never stopped - and it holds
  // the whole call's chunks in memory for as long as the process lives.
  const { registry, closed, page, sweep } = tabHarness();
  registry.register('marathon', page('marathon'), 'LONG 2026Q1', Date.now() - 95 * 60000);
  sweep({ isRecording: () => true });
  assert.deepStrictEqual(closed, ['marathon'], 'the hard limit applies even while recording');
});

check('CallTabRegistry: the hard limit is measured from the CALL, not from the tab', () => {
  // Tabs open up to fifteen minutes early, and that head start must not eat the allowance.
  const { registry, closed, page, sweep } = tabHarness();
  // Opened 100 minutes ago for a call that started 85 minutes ago: inside the limit.
  const entry = registry.tabs;
  registry.register('early-open', page('early-open'), 'EARLY 2026Q1', Date.now() - 85 * 60000);
  entry.get('early-open').openedAt = Date.now() - 100 * 60000;
  sweep({ isRecording: () => true });
  assert.deepStrictEqual(closed, [], '85 minutes into the call is still inside the limit');
});

check('CallTabRegistry: an undated row is untouched by the hard limit', () => {
  // dueAt is null when the portal gave no time. There is no call start to measure from, so the
  // age caps are all that apply - and a live capture is still never interrupted by those.
  const { registry, closed, page, sweep } = tabHarness();
  registry.register('undated', page('undated'), 'UNDATED 2026Q1', null);
  for (let poll = 0; poll < 3; poll++) sweep({ isRecording: () => true, pastStartMaxMs: -1 });
  assert.deepStrictEqual(closed, [], 'with no scheduled time the hard limit cannot fire');
});

check('CallTabRegistry: hasExpiredByCallStart spots a tab past the hard limit', () => {
  const { registry, page } = tabHarness();
  registry.register('fresh', page('fresh'), 'FRESH 2026Q1', Date.now() - 10 * 60000);
  assert.strictEqual(registry.hasExpiredByCallStart(90 * 60000), false);
  registry.register('stale', page('stale'), 'STALE 2026Q1', Date.now() - 95 * 60000);
  assert.strictEqual(registry.hasExpiredByCallStart(90 * 60000), true);
});

check('CallTabRegistry: re-registering a key does not leak the previous tab', () => {
  const { CallTabRegistry } = require('../../src/callTabs');
  const closed = [];
  const fakePage = (name) => ({ isClosed: () => false, close: () => { closed.push(name); return Promise.resolve(); } });
  const reg = new CallTabRegistry({ info: () => {}, warn: () => {} });
  reg.register('k', fakePage('first'), 'X');
  reg.register('k', fakePage('second'), 'X');
  assert.deepStrictEqual(closed, ['first']);
  assert.strictEqual(reg.size(), 1);
});

check('CallTabRegistry: drops tabs the user already closed', () => {
  const { CallTabRegistry } = require('../../src/callTabs');
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

// ---------------------------------------------------------------- restart revival

// The attempt cap should stop a call retrying forever WITHIN a session, and still does. But a
// restart is almost always an operator acting on a fix, and a verdict reached by code that no
// longer exists should not outlive it. Observed live: NSSC 2026Q4 failed four times against a
// too-strict relevance check, the check was corrected minutes later, and the call remained
// unreachable because its record said failed/attempts=4 - the fix was live and unusable.
check('stateStore: a restart gives exhausted failures another full set of attempts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-revive-'));
  const file = path.join(dir, 'processed.json');
  const store = new StateStore(file);

  store.claim('EXHAUSTED|2026Q1|2026-08-24');
  for (let i = 0; i < 4; i++) {
    store.fail('EXHAUSTED|2026Q1|2026-08-24', 'too strict', 1000);
    if (i < 3) store.claim('EXHAUSTED|2026Q1|2026-08-24');
  }
  store.claim('MIDWAY|2026Q1|2026-08-24');
  store.fail('MIDWAY|2026Q1|2026-08-24', 'one failure', 1000);
  store.claim('DONE|2026Q1|2026-08-24');
  store.markStarted('DONE|2026Q1|2026-08-24');

  const exhaustedBefore = store.get('EXHAUSTED|2026Q1|2026-08-24').attempts;
  assert.ok(exhaustedBefore >= 4, `expected the cap to have been reached, got ${exhaustedBefore}`);

  const revived = store.resetExhaustedFailures(4);
  assert.deepStrictEqual(revived.map((r) => r.key), ['EXHAUSTED|2026Q1|2026-08-24']);
  assert.strictEqual(store.get('EXHAUSTED|2026Q1|2026-08-24').attempts, 0);
  assert.ok(store.retryDue('EXHAUSTED|2026Q1|2026-08-24'), 'the revived call must be retryable now');
  // The reason is kept: it is what the operator reads to know WHY it had given up.
  assert.match(store.get('EXHAUSTED|2026Q1|2026-08-24').lastError, /too strict/);

  // A call still inside its budget is untouched - its backoff must not be reset out from under
  // it - and a call that already recorded must never be resurrected and recorded twice.
  assert.strictEqual(store.get('MIDWAY|2026Q1|2026-08-24').attempts, 1);
  assert.strictEqual(store.get('DONE|2026Q1|2026-08-24').status, 'started');

  // Survives the reload, or the next restart would revive it all over again.
  assert.strictEqual(new StateStore(file).get('EXHAUSTED|2026Q1|2026-08-24').attempts, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

check('stateStore: reviving nothing is a no-op', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-revive2-'));
  const store = new StateStore(path.join(dir, 'processed.json'));
  store.claim('A|2026Q1|2026-08-24');
  store.markStarted('A|2026Q1|2026-08-24');
  assert.deepStrictEqual(store.resetExhaustedFailures(4), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- late calls

// An attempt has to begin before the call does. A late join is not a partial success - it is a
// failure shaped like one: it confirms "started", logs Done, and files a transcript missing the
// opening remarks and guidance, which nothing downstream can distinguish from a complete one.

check('dispatchRules: attempts are allowed right up to the scheduled time', () => {
  for (const minsLeft of [15, 5, 1, 0.5, 0.1]) {
    assert.strictEqual(shouldSkipAsLate({ minsLeft, record: null }), null, `${minsLeft} min out must be allowed`);
  }
});

check('dispatchRules: once the call has started it is gone', () => {
  const skip = shouldSkipAsLate({ minsLeft: -0.5, record: null });
  assert.ok(skip, 'a call 30s past its start must not be attempted');
  assert.strictEqual(skip.attempts, 0);
  assert.strictEqual(skip.reason, 'never attempted');
  assert.strictEqual(skip.minsPastStart, 0.5);
});

check('dispatchRules: a call that failed inside the window is not retried past the start', () => {
  // This is the case the old rule missed entirely: it only gated calls with NO record, so one
  // that failed at minute 3 kept retrying well past the start, spending the pipeline lock on a
  // capture that could no longer be complete - and delaying calls that had not started yet.
  const record = { status: 'failed', attempts: 2 };
  assert.strictEqual(shouldSkipAsLate({ minsLeft: 2, record }), null, 'still in the window: retry away');
  const skip = shouldSkipAsLate({ minsLeft: -1, record });
  assert.ok(skip, 'past the start: stop retrying');
  assert.strictEqual(skip.reason, 'attempted 2x without success');
});

check('dispatchRules: a claimed-but-unfinished call is also not resumed past the start', () => {
  assert.ok(shouldSkipAsLate({ minsLeft: -2, record: { status: 'claimed', attempts: 1 } }));
});

check('dispatchRules: a capture already running is never treated as late', () => {
  // Its stream dropping mid-call is a different problem - reacquiring keeps a capture alive
  // that is already running, and is governed by reacquireGraceMinutes instead. Treating this
  // as "late" would abandon the rest of a call we were successfully recording.
  for (const minsLeft of [-1, -20, -90]) {
    assert.strictEqual(
      shouldSkipAsLate({ minsLeft, record: { status: 'started', attempts: 1 } }),
      null,
      `a live capture ${Math.abs(minsLeft)} min in must not be dropped`
    );
  }
});

check('dispatchRules: a tolerance can still be configured for anyone who wants one', () => {
  assert.strictEqual(shouldSkipAsLate({ minsLeft: -3, record: null, lateStartGraceMinutes: 5 }), null);
  assert.ok(shouldSkipAsLate({ minsLeft: -6, record: null, lateStartGraceMinutes: 5 }));
});

// ---------------------------------------------------------------- concurrency

// These back the batch pipeline: calls are PREPARED several at a time and then TRIGGERED one
// at a time. The trigger has to stay exclusive because it brings a tab to the foreground and
// drives a popup that dies when its tab loses focus.

checkAsync('mapWithConcurrency: never exceeds the width, and keeps input order', async () => {
  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 12 }, (_, i) => i);
  const results = await mapWithConcurrency(items, 3, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5 + (n % 3) * 5));
    inFlight--;
    return n * 2;
  });
  assert.ok(peak <= 3, `width exceeded: peak ${peak}`);
  assert.ok(peak > 1, 'nothing actually ran concurrently');
  // Order matters: the batch pairs results back to rows positionally.
  assert.deepStrictEqual(results.map((r) => r.value), items.map((n) => n * 2));
});

checkAsync('mapWithConcurrency: one failing call cannot take the batch down with it', async () => {
  // The whole point. Before the split, a throw propagated out of the queued pipeline; here a
  // bad call must cost only itself, because the others are calls in the same 15-minute window.
  const results = await mapWithConcurrency([1, 2, 3, 4], 2, async (n) => {
    if (n === 2) throw new Error('provider exploded');
    return n;
  });
  assert.deepStrictEqual(results.map((r) => r.ok), [true, false, true, true]);
  assert.strictEqual(results[1].error.message, 'provider exploded');
  assert.deepStrictEqual(results.filter((r) => r.ok).map((r) => r.value), [1, 3, 4]);
});

checkAsync('mapWithConcurrency: a width larger than the batch is harmless', async () => {
  const results = await mapWithConcurrency([1, 2], 10, async (n) => n);
  assert.deepStrictEqual(results.map((r) => r.value), [1, 2]);
  assert.deepStrictEqual((await mapWithConcurrency([], 3, async () => 1)), []);
});

checkAsync('Mutex: serializes, and one rejection does not poison the lock', async () => {
  const mutex = new Mutex();
  const order = [];
  let overlapping = 0;
  const task = (name, ms) =>
    mutex.run(async () => {
      overlapping++;
      assert.strictEqual(overlapping, 1, `${name} overlapped another holder`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(name);
      overlapping--;
      if (name === 'b') throw new Error('boom');
    });

  const results = await Promise.allSettled([task('a', 20), task('b', 5), task('c', 1)]);
  assert.deepStrictEqual(order, ['a', 'b', 'c'], 'must run in submission order');
  assert.deepStrictEqual(results.map((r) => r.status), ['fulfilled', 'rejected', 'fulfilled']);
  // The caller of the failing task still sees the real error...
  assert.strictEqual(results[1].reason.message, 'boom');
  // ...and the lock is still usable afterwards, which is what matters for the portal tab.
  assert.strictEqual(await mutex.run(async () => 'still works'), 'still works');
});

checkAsync('withDeadline: bounds a hang and passes a fast result through', async () => {
  assert.strictEqual(await withDeadline(Promise.resolve('fast'), 500, 'too slow'), 'fast');
  await assert.rejects(
    () => withDeadline(new Promise(() => {}), 30, 'preparation exceeded its limit'),
    /preparation exceeded its limit/
  );
  // The timer must be cleared even on the fast path, or the process would not exit on Ctrl+C.
  const before = process._getActiveHandles().length;
  await withDeadline(Promise.resolve(1), 60000, 'unused');
  assert.ok(process._getActiveHandles().length <= before, 'a timer was left running');
});

// These exercise the REAL orchestrator the poll loop uses, with the Playwright work stubbed
// out - so the ordering guarantees are tested rather than assumed. Every symbol in a batch goes
// through the same two phases in the same order; only how many preparations run beside it
// differs.

checkAsync('runPreparedBatch: prepares in parallel but never overlaps two triggers', async () => {
  // The load-bearing rule. Triggering brings a tab to the foreground and drives a popup that
  // closes the instant its tab loses focus, so two at once means one capture records the wrong
  // tab - or no tab at all. Verified behaviour in this project, not a theoretical concern.
  const symbols = ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN'];
  let preparingNow = 0;
  let peakPreparing = 0;
  let triggeringNow = 0;
  const triggerOrder = [];

  await runPreparedBatch(symbols.map((symbol) => ({ symbol })), {
    width: 3,
    prepare: async ({ symbol }) => {
      preparingNow++;
      peakPreparing = Math.max(peakPreparing, preparingNow);
      await new Promise((r) => setTimeout(r, 10));
      preparingNow--;
      return { symbol, page: `page:${symbol}` };
    },
    trigger: async (prepared, { symbol }) => {
      triggeringNow++;
      assert.strictEqual(triggeringNow, 1, `two triggers overlapped at ${symbol}`);
      assert.strictEqual(prepared.symbol, symbol, `a trigger got another row's prepared page`);
      await new Promise((r) => setTimeout(r, 5));
      triggerOrder.push(symbol);
      triggeringNow--;
    },
  });

  assert.ok(peakPreparing > 1, 'preparation did not actually run in parallel');
  assert.ok(peakPreparing <= 3, `preparation exceeded its width: ${peakPreparing}`);
  // Order is preserved so the most urgent call - the batch arrives sorted by time left - is
  // triggered first, and so every symbol is accounted for.
  assert.deepStrictEqual(triggerOrder, symbols);
});

checkAsync('runPreparedBatch: every symbol in the window is accounted for, failures included', async () => {
  // "It must follow the exact same steps for each and every symbol" - so a batch must never
  // silently drop one. Each symbol ends up either triggered or reported, never neither.
  const symbols = ['A', 'B', 'C', 'D', 'E', 'F'];
  const triggered = [];
  const failed = [];

  await runPreparedBatch(symbols.map((symbol) => ({ symbol })), {
    width: 3,
    prepare: async ({ symbol }) => {
      if (symbol === 'B') throw new Error('registration gate still active');
      if (symbol === 'D') throw new Error('preparation exceeded its limit');
      return { symbol };
    },
    trigger: async (prepared) => {
      triggered.push(prepared.symbol);
    },
    onPrepareFailure: async ({ symbol }, error) => {
      failed.push(`${symbol}: ${error.message}`);
    },
  });

  assert.deepStrictEqual(triggered, ['A', 'C', 'E', 'F']);
  assert.deepStrictEqual(failed, ['B: registration gate still active', 'D: preparation exceeded its limit']);
  assert.strictEqual(triggered.length + failed.length, symbols.length, 'a symbol went missing');
});

checkAsync('runPreparedBatch: a failing trigger does not abandon the calls behind it', async () => {
  const triggered = [];
  await assert.doesNotReject(() =>
    runPreparedBatch([{ symbol: 'A' }, { symbol: 'B' }, { symbol: 'C' }], {
      width: 2,
      prepare: async (item) => item,
      trigger: async ({ symbol }) => {
        // index.js's trigger callback handles its own errors; this mirrors that contract.
        try {
          if (symbol === 'A') throw new Error('popup never opened');
          triggered.push(symbol);
        } catch {
          triggered.push(`${symbol}(failed)`);
        }
      },
    })
  );
  assert.deepStrictEqual(triggered, ['A(failed)', 'B', 'C']);
});

checkAsync('runPreparedBatch: a single call behaves exactly as it always did', async () => {
  const steps = [];
  await runPreparedBatch([{ symbol: 'SOLO' }], {
    width: 3,
    prepare: async ({ symbol }) => {
      steps.push(`prepare:${symbol}`);
      return { symbol };
    },
    trigger: async ({ symbol }) => {
      steps.push(`trigger:${symbol}`);
    },
  });
  assert.deepStrictEqual(steps, ['prepare:SOLO', 'trigger:SOLO']);
});

// ---------------------------------------------------------------- frozen countdowns

// transcriptionTimeText is a SNAPSHOT. Re-reading it later yields the value it had when it was
// scraped, forever - which is why the trigger's last-moment lateness guard silently never
// fired. Anything that re-checks the clock must go through the stamped instant instead.

check('tableWatcher: minutesUntilCall is frozen, minutesRemaining is not', () => {
  const row = { transcriptionTimeText: '2 min 30 sec' };
  const t0 = 1_000_000_000_000;
  approx(minutesUntilCall(row), 2.5);

  stampDueAt(row, minutesUntilCall(row), t0);
  approx(minutesRemaining(row, t0), 2.5);
  // 90 seconds later the countdown TEXT still says 2 min 30 sec...
  approx(minutesUntilCall(row), 2.5);
  // ...but the stamped instant has moved.
  approx(minutesRemaining(row, t0 + 90_000), 1.0);
  // And it goes negative once the call has started, which is what the guard depends on.
  assert.ok(minutesRemaining(row, t0 + 200_000) < 0, 'must go negative after the call starts');
});

check('tableWatcher: an unstamped row still behaves exactly as before', () => {
  // The fallback path: nothing that skipped stampDueAt should change behaviour.
  approx(minutesRemaining({ transcriptionTimeText: '45 min' }), 45);
  assert.strictEqual(minutesRemaining({ transcriptionTimeText: 'gibberish' }), null);
  // A malformed stamp must not be trusted over the text.
  approx(minutesRemaining({ transcriptionTimeText: '10 min', dueAt: NaN }), 10);
});

// ---------------------------------------------------------------- abandoned claims

check('stateStore: claims abandoned by a dead process are released at startup', () => {
  // A claim says "a pipeline is working on this". retryDue() honours that for 30 minutes so two
  // pipelines cannot take the same call - correct while the process lives, and a lost call when
  // it does not, because an attempt must now begin before the call starts.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-claims-'));
  const file = path.join(dir, 'processed.json');
  const store = new StateStore(file);

  store.claim('STUCK|2026Q1|2026-08-24');
  store.claim('ALSOSTUCK|2026Q1|2026-08-24');
  store.claim('LIVE|2026Q1|2026-08-24');
  store.markStarted('LIVE|2026Q1|2026-08-24');
  store.claim('DONE|2026Q1|2026-08-24');
  store.markCompleted('DONE|2026Q1|2026-08-24', 'finished');

  assert.strictEqual(store.retryDue('STUCK|2026Q1|2026-08-24'), false, 'a fresh claim blocks retry');

  const released = store.releaseStaleClaims();
  assert.deepStrictEqual(released.map((r) => r.key).sort(), ['ALSOSTUCK|2026Q1|2026-08-24', 'STUCK|2026Q1|2026-08-24']);
  assert.strictEqual(store.retryDue('STUCK|2026Q1|2026-08-24'), true, 'released claims must be retryable at once');

  // The attempt count survives: deleting the record instead would restart the series and
  // re-enable the ~200-retry defect this codebase already had once.
  assert.strictEqual(store.get('STUCK|2026Q1|2026-08-24').attempts, 1);
  assert.match(store.get('STUCK|2026Q1|2026-08-24').lastError, /process exited/);

  // A live capture and a finished call must be left completely alone.
  assert.strictEqual(store.get('LIVE|2026Q1|2026-08-24').status, 'started');
  assert.strictEqual(store.get('DONE|2026Q1|2026-08-24').status, 'completed');

  // Survives the reload, or the next start would report the same claims again.
  assert.strictEqual(new StateStore(file).get('STUCK|2026Q1|2026-08-24').status, 'failed');
  fs.rmSync(dir, { recursive: true, force: true });
});

check('stateStore: releasing with nothing claimed is a no-op', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-claims2-'));
  const store = new StateStore(path.join(dir, 'processed.json'));
  assert.deepStrictEqual(store.releaseStaleClaims(), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- reconciliation

// The ledger records what was ATTEMPTED. This covers what was not: a row with no link, a row
// whose time never parsed, and above all a row that reached the window and produced no ledger
// entry whatsoever. That last one is invisible everywhere else in the system - a day where
// twenty calls silently never became due reads exactly like a quiet day.
function withDay(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-recon-'));
  const quiet = { info() {}, warn() {}, error() {} };
  try {
    return fn(dir, quiet);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

check('reconciliation: every observed call lands in exactly one bucket', () => {
  withDay((dir, quiet) => {
    const seen = new SeenLog(dir, quiet);
    const row = (symbol, opts) =>
      seen.observe({
        key: `${symbol}|2026Q2|2026-08-24`,
        symbol,
        fiscalPeriod: '2026Q2',
        earningsDate: '2026-08-24',
        hasLink: true,
        timeParsed: true,
        insideWindow: true,
        ...opts,
      });
    row('GOOD');
    row('BROKE');
    row('TOOLATE');
    row('NOLINK', { hasLink: false, insideWindow: false });
    row('NOTIME', { timeParsed: false, insideWindow: false });
    row('GHOST');                               // reached the window, no ledger entry at all
    row('TOMORROW', { insideWindow: false });   // seen, but never due today
    seen.flush();

    const obs = createObservability(dir, quiet);
    obs.recordOutcome({ status: 'started', symbol: 'GOOD', fiscalPeriod: '2026Q2' });
    obs.recordOutcome({ status: 'failed', symbol: 'BROKE', fiscalPeriod: '2026Q2', error: 'gate still active' });
    obs.recordOutcome({ status: 'skipped-late', symbol: 'TOOLATE', fiscalPeriod: '2026Q2', reason: 'never attempted' });

    const r = reconcile(dir);
    assert.deepStrictEqual(r.recorded.map((x) => x.label), ['GOOD 2026Q2']);
    assert.deepStrictEqual(r.failed.map((x) => x.label), ['BROKE 2026Q2']);
    assert.deepStrictEqual(r.missedLate.map((x) => x.label), ['TOOLATE 2026Q2']);
    assert.deepStrictEqual(r.noDialinLink.map((x) => x.label), ['NOLINK 2026Q2']);
    assert.deepStrictEqual(r.noReadableTime.map((x) => x.label), ['NOTIME 2026Q2']);
    assert.deepStrictEqual(r.unaccounted.map((x) => x.label), ['GHOST 2026Q2'], 'the bucket this report exists for');
    assert.deepStrictEqual(r.notDueToday.map((x) => x.label), ['TOMORROW 2026Q2']);

    // The invariant: buckets are disjoint and complete. If this ever fails, the report lies.
    const counted = ['recorded', 'failed', 'missedLate', 'noDialinLink', 'noReadableTime', 'unaccounted', 'notDueToday']
      .reduce((sum, b) => sum + r[b].length, 0);
    assert.strictEqual(counted, r.totalSeen, 'every seen call must be in exactly one bucket');
  });
});

check('reconciliation: a call that failed then succeeded counts as recorded, once', () => {
  withDay((dir, quiet) => {
    const seen = new SeenLog(dir, quiet);
    seen.observe({
      key: 'RETRY|2026Q2|2026-08-24', symbol: 'RETRY', fiscalPeriod: '2026Q2',
      earningsDate: '2026-08-24', hasLink: true, timeParsed: true, insideWindow: true,
    });
    seen.flush();
    const obs = createObservability(dir, quiet);
    obs.recordOutcome({ status: 'failed', symbol: 'RETRY', fiscalPeriod: '2026Q2', error: 'first try' });
    obs.recordOutcome({ status: 'started', symbol: 'RETRY', fiscalPeriod: '2026Q2' });

    const r = reconcile(dir);
    assert.deepStrictEqual(r.recorded.map((x) => x.label), ['RETRY 2026Q2']);
    assert.strictEqual(r.failed.length, 0, 'a recovered call must not also be reported as failed');
  });
});

check('reconciliation: sticky flags survive a row leaving the table', () => {
  withDay((dir, quiet) => {
    const seen = new SeenLog(dir, quiet);
    const base = { key: 'K|2026Q2|2026-08-24', symbol: 'K', fiscalPeriod: '2026Q2', earningsDate: '2026-08-24' };
    // Seen early with no link and a distant time...
    seen.observe({ ...base, hasLink: false, timeParsed: true, insideWindow: false });
    // ...then inside the window with a link...
    seen.observe({ ...base, hasLink: true, timeParsed: true, insideWindow: true });
    // ...then the portal drops the row's link once the call starts.
    seen.observe({ ...base, hasLink: false, timeParsed: false, insideWindow: false });
    seen.flush();
    // It must still be judged as having reached the window with a usable link, or a call that
    // vanishes from the table after starting would be excused as never having been due.
    const r = reconcile(dir);
    assert.deepStrictEqual(r.unaccounted.map((x) => x.label), ['K 2026Q2']);
  });
});

check('reconciliation: an empty day reports nothing rather than throwing', () => {
  withDay((dir) => {
    const r = reconcile(dir);
    assert.strictEqual(r.totalSeen, 0);
    assert.deepStrictEqual(r.unaccounted, []);
  });
});

// ---------------------------------------------------------------- supervisor

check('supervisor: restarts only on states where the watcher cannot do its job', () => {
  const fresh = (over) => ({ pid: 42, updatedAt: new Date().toISOString(), warnings: {}, ...over });
  assert.strictEqual(blindReason(fresh(), { pid: 42 }), null, 'a healthy watcher must be left alone');
  // No heartbeat yet is the start grace's problem - killing a booting process never terminates.
  assert.strictEqual(blindReason(null, { pid: 42 }), null);
  // A heartbeat from a PREVIOUS run says nothing about this child.
  assert.strictEqual(blindReason(fresh({ pid: 7, warnings: { noRows: true } }), { pid: 42 }), null);

  const cases = [
    ['chromeDisconnected', /Chrome is disconnected/],
    ['noRows', /zero rows/],
    ['noLinks', /zero dial-in links/],
    ['noReadableTimes', /Transcription Time/],
    ['cannotReadStreams', /stream list/],
  ];
  for (const [flag, expected] of cases) {
    assert.match(blindReason(fresh({ warnings: { [flag]: true } }), { pid: 42 }), expected, flag);
  }
});

check('supervisor: a stopped poll loop is caught by heartbeat age', () => {
  const stale = { pid: 42, updatedAt: new Date(Date.now() - 600000).toISOString(), warnings: {} };
  assert.match(blindReason(stale, { pid: 42, staleAfterMs: 300000 }), /heartbeat is \d+s old/);
  // Just inside the limit is fine - a slow batch must not be mistaken for a dead loop.
  const recent = { pid: 42, updatedAt: new Date(Date.now() - 60000).toISOString(), warnings: {} };
  assert.strictEqual(blindReason(recent, { pid: 42, staleAfterMs: 300000 }), null);
  // A garbled timestamp must not read as infinitely old and cause a restart loop.
  assert.strictEqual(blindReason({ pid: 42, updatedAt: 'not-a-date', warnings: {} }, { pid: 42 }), null);
});

// ---------------------------------------------------------------- config validation

// Every numeric setting is read as `config.x ?? default`, so a typo is not an error - it is
// silently the default, and the day runs under rules nobody chose.
const BASE_CONFIG = {
  portalUrl: 'https://admin.example.com/?section=x',
  cdpUrl: 'http://127.0.0.1:9222',
  extensionShortcutSendKeys: '^+y',
  dummyIdentity: { firstName: 'a', lastName: 'b', email: 'a@b.com', phone: '1', company: 'c', country: 'USA' },
  knownDirectProviderDomains: ['zoom.us'],
};

check('validateConfig: the config actually shipped is valid', () => {
  // Guards against a settings change landing without its spec entry - which would make every
  // other test here pass while the real file quietly fails to start.
  const result = validateConfig(loadConfig());
  assert.ok(result.ok, `shipped config.json is invalid: ${result.errors.join('; ')}`);
  assert.deepStrictEqual(result.warnings, [], `shipped config.json has warnings: ${result.warnings.join('; ')}`);
});

check('validateConfig: a misspelled key is reported, not silently ignored', () => {
  const result = validateConfig({ ...BASE_CONFIG, treshholdMinutes: 15 });
  assert.ok(result.ok, 'an unknown key must not block startup - that would punish adding settings');
  assert.match(result.warnings.join('\n'), /treshholdMinutes/);
});

check('validateConfig: out-of-range and wrong-type values stop the run', () => {
  assert.ok(!validateConfig({ ...BASE_CONFIG, maxAttempts: 0 }).ok, 'zero attempts would never try');
  assert.ok(!validateConfig({ ...BASE_CONFIG, pollIntervalMs: 10 }).ok, '10ms polling would hammer the portal');
  assert.ok(!validateConfig({ ...BASE_CONFIG, thresholdMinutes: -5 }).ok);
  assert.ok(!validateConfig({ ...BASE_CONFIG, absentObservationsBeforeComplete: 1.5 }).ok, 'must be whole');
  assert.ok(!validateConfig({ ...BASE_CONFIG, cdpUrl: 'not a url' }).ok);
  assert.ok(!validateConfig({ ...BASE_CONFIG, portalUrl: undefined, cdpUrl: 'http://x' }).ok, 'required key missing');
});

check('validateConfig: a quoted number works but is called out', () => {
  const result = validateConfig({ ...BASE_CONFIG, thresholdMinutes: '15' });
  assert.ok(result.ok, 'it is coerced everywhere, so it must not block the run');
  assert.match(result.warnings.join('\n'), /rather than the number 15/);
});

check('validateConfig: a mistyped extension ID is caught before the trigger step', () => {
  // Otherwise this surfaces as a popup that never opens, minutes into a real call.
  assert.ok(!validateConfig({ ...BASE_CONFIG, extensionId: 'not-an-id' }).ok);
  assert.ok(!validateConfig({ ...BASE_CONFIG, extensionId: 'abcdefghijklmnopqrstuvwxyz123456' }).ok, 'z is out of range');
  assert.ok(validateConfig({ ...BASE_CONFIG, extensionId: 'ajemmhlcfahhacllbjofkbbeageaedia' }).ok);
  assert.ok(validateConfig({ ...BASE_CONFIG, extensionId: null }).ok, 'null means auto-detect');
});

check('validateConfig: a provider entry written as a URL can never match', () => {
  // hostnameMatches compares hostnames, so "https://zoom.us/" silently matches nothing.
  const result = validateConfig({ ...BASE_CONFIG, knownDirectProviderDomains: ['https://zoom.us/j'] });
  assert.ok(!result.ok);
  assert.match(result.errors.join('\n'), /bare hostname/);
});

check('validateConfig: settings that are individually fine but jointly wrong', () => {
  // One call must fit comfortably inside the window, or the first dispatch can consume it.
  const tight = validateConfig({ ...BASE_CONFIG, thresholdMinutes: 2, prepareDeadlineMs: 120000, triggerDeadlineMs: 90000 });
  assert.match(tight.warnings.join('\n'), /exceeds the whole 2-minute window/);

  // Polling slower than half the window can miss a call that enters and passes between ticks.
  const slow = validateConfig({ ...BASE_CONFIG, thresholdMinutes: 15, pollIntervalMs: 600000 });
  assert.match(slow.warnings.join('\n'), /more than half/);
});

// ---------------------------------------------------------------- instance lock

// Two watchers on one Chrome and one data directory corrupt each other. processed.json is
// rewritten whole from memory, so last-write-wins can erase a claim and dispatch the same call
// twice; and the extension popup is a single global resource the batch pipeline already
// serializes carefully within one process. This happened during testing - two were running and
// the heartbeat described whichever wrote last.

check('instanceLock: a second instance is refused while the first is alive', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-lock-'));
  // process.pid is, by definition, a live process - the most honest stand-in for "the other
  // watcher is still running".
  const first = acquireInstanceLock(dir, { pid: process.pid });
  assert.ok(first.ok);

  const second = acquireInstanceLock(dir, { pid: process.pid + 1 });
  assert.strictEqual(second.ok, false, 'a live holder must block a second instance');
  assert.strictEqual(second.holder.pid, process.pid);
  fs.rmSync(dir, { recursive: true, force: true });
});

check('instanceLock: a lock left by a crashed process is taken over, not honoured', () => {
  // Otherwise a hard kill would require deleting a file by hand before the watcher could run
  // again - making the safeguard itself a source of downtime.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-lock2-'));
  // PID 0x7FFFFFFF is not a real process on any platform this runs on.
  fs.writeFileSync(lockPathFor(dir), JSON.stringify({ pid: 2147483647, startedAt: '2026-01-01T00:00:00.000Z' }));

  const result = acquireInstanceLock(dir, { pid: process.pid });
  assert.ok(result.ok, 'a dead holder must not block startup');
  assert.strictEqual(result.takeover.pid, 2147483647, 'the takeover is reported so it reaches the log');
  fs.rmSync(dir, { recursive: true, force: true });
});

check('instanceLock: a corrupt lock file does not wedge startup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-lock3-'));
  fs.writeFileSync(lockPathFor(dir), 'not json at all');
  assert.ok(acquireInstanceLock(dir, { pid: process.pid }).ok);
  fs.rmSync(dir, { recursive: true, force: true });
});

check('instanceLock: releasing only removes a lock we still hold', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-lock4-'));
  acquireInstanceLock(dir, { pid: process.pid });

  // A late exit handler from a previous holder must not delete the successor's lock.
  assert.strictEqual(releaseInstanceLock(dir, { pid: process.pid + 1 }), false);
  assert.ok(fs.existsSync(lockPathFor(dir)), 'the current holder keeps its lock');

  assert.strictEqual(releaseInstanceLock(dir, { pid: process.pid }), true);
  assert.ok(!fs.existsSync(lockPathFor(dir)), 'a clean exit leaves no lock behind');
  // Releasing twice is harmless.
  assert.strictEqual(releaseInstanceLock(dir, { pid: process.pid }), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

check('instanceLock: re-acquiring your own lock is allowed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-lock5-'));
  assert.ok(acquireInstanceLock(dir, { pid: process.pid }).ok);
  assert.ok(acquireInstanceLock(dir, { pid: process.pid }).ok, 'the same pid must not lock itself out');
  fs.rmSync(dir, { recursive: true, force: true });
});

check('instanceLock: an unrefreshed lock expires even when its pid is alive', () => {
  // The failure this prevents is specific and was hit for real: Windows recycles pids fast, so
  // a hard-killed watcher leaves a lock whose number the OS later hands to some unrelated
  // process. Judged on liveness alone, that lock looks held forever and no watcher can start
  // again without someone deleting a file - the safeguard becoming an outage.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-lock6-'));
  fs.writeFileSync(
    lockPathFor(dir),
    JSON.stringify({
      pid: process.pid, // deliberately a pid that IS running
      startedAt: '2026-01-01T00:00:00.000Z',
      refreshedAt: new Date(Date.now() - 600000).toISOString(),
    })
  );

  const result = acquireInstanceLock(dir, { pid: process.pid + 1, staleAfterMs: 120000 });
  assert.ok(result.ok, 'a lock nobody is refreshing must not block startup forever');
  assert.match(result.takeover.reason, /not been refreshed/);
  fs.rmSync(dir, { recursive: true, force: true });
});

check('instanceLock: a lock being refreshed is still respected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-lock7-'));
  acquireInstanceLock(dir, { pid: process.pid });
  assert.ok(refreshInstanceLock(dir, { pid: process.pid }), 'the holder can refresh its own lock');

  const second = acquireInstanceLock(dir, { pid: process.pid + 1, staleAfterMs: 120000 });
  assert.strictEqual(second.ok, false, 'a live, freshly-refreshed lock must be honoured');
  fs.rmSync(dir, { recursive: true, force: true });
});

check('instanceLock: only the holder may refresh', () => {
  // Otherwise a departing process could keep stamping a lock it no longer owns, and the real
  // holder would never be able to prove staleness.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-lock8-'));
  acquireInstanceLock(dir, { pid: process.pid });
  assert.strictEqual(refreshInstanceLock(dir, { pid: process.pid + 1 }), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

check('instanceLock: a lock from an older build without refreshedAt still expires', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-lock9-'));
  // No refreshedAt at all - must fall back to startedAt rather than being immortal.
  fs.writeFileSync(lockPathFor(dir), JSON.stringify({ pid: process.pid, startedAt: '2026-01-01T00:00:00.000Z' }));
  const result = acquireInstanceLock(dir, { pid: process.pid + 1, staleAfterMs: 120000 });
  assert.ok(result.ok);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- one line per call

// The ledger is per-ATTEMPT, which is what makes a retry sequence auditable. Reports are per
// CALL. A call retried four times printed the same sentence four times on every Ctrl+C, which
// read as four separate problems - and the summary said failed=4 while the reconciliation
// block printed directly beneath it said failed=1, about the same day.

check('observability: a call retried four times is one failure, with the count kept', () => {
  withTempObs((obs) => {
    for (let i = 1; i <= 4; i++) {
      obs.recordOutcome({ status: 'failed', symbol: 'NSSC', fiscalPeriod: '2026Q4', error: `try ${i}`, attempts: i });
    }
    const s = obs.summarize();
    assert.strictEqual(s.failed.length, 1, 'four attempts on one call is one failed call');
    assert.strictEqual(s.failed[0].attempts, 4, 'the retries stay visible without repeating');
    assert.strictEqual(s.failed[0].error, 'try 4', 'the last attempt is the outcome that stands');
    // The raw ledger is untouched: per-attempt detail is still on disk for a post-mortem.
    assert.strictEqual(s.total, 4);
  });
});

check('observability: repeated successes and misses collapse the same way', () => {
  withTempObs((obs) => {
    // A reacquired call can legitimately start more than once.
    obs.recordOutcome({ status: 'started', symbol: 'AAPL', fiscalPeriod: '2026Q2' });
    obs.recordOutcome({ status: 'started', symbol: 'AAPL', fiscalPeriod: '2026Q2' });
    obs.recordOutcome({ status: 'skipped-late', symbol: 'TSLA', fiscalPeriod: '2026Q2', minsPastStart: 3 });
    obs.recordOutcome({ status: 'skipped-late', symbol: 'TSLA', fiscalPeriod: '2026Q2', minsPastStart: 9 });
    const s = obs.summarize();
    assert.strictEqual(s.started.length, 1);
    assert.strictEqual(s.started[0].attempts, 2);
    assert.strictEqual(s.skippedLate.length, 1);
    assert.strictEqual(s.skippedLate[0].minsPastStart, 9, 'the latest reading wins');
  });
});

check('observability: a recovered call is counted once, and not as a failure', () => {
  withTempObs((obs) => {
    obs.recordOutcome({ status: 'failed', symbol: 'X', fiscalPeriod: '2026Q1', error: 'first' });
    obs.recordOutcome({ status: 'failed', symbol: 'X', fiscalPeriod: '2026Q1', error: 'second' });
    obs.recordOutcome({ status: 'started', symbol: 'X', fiscalPeriod: '2026Q1' });
    const s = obs.summarize();
    assert.strictEqual(s.failed.length, 0);
    assert.deepStrictEqual(s.retriedThenStarted, ['X 2026Q1'], 'listed once, not once per failed attempt');
  });
});

check('reconciliation: a retried failure prints as one line carrying its attempt count', () => {
  withDay((dir, quiet) => {
    const seen = new SeenLog(dir, quiet);
    seen.observe({
      key: 'NSSC|2026Q4|2026-08-24', symbol: 'NSSC', fiscalPeriod: '2026Q4',
      earningsDate: '2026-08-24', hasLink: true, timeParsed: true, insideWindow: true,
    });
    seen.flush();
    const obs = createObservability(dir, quiet);
    for (let i = 1; i <= 4; i++) {
      obs.recordOutcome({ status: 'failed', symbol: 'NSSC', fiscalPeriod: '2026Q4', error: 'wrong page' });
    }

    const r = reconcile(dir);
    assert.strictEqual(r.failed.length, 1);
    assert.strictEqual(r.failed[0].attempts, 4);

    const printed = formatReconciliation(r).filter((l) => l.includes('NSSC'));
    assert.strictEqual(printed.length, 1, 'exactly one line for the call, not one per attempt');
    assert.match(printed[0], /4 attempts/);
  });
});

check('reconciliation: a call whose row already left the table reports identically', () => {
  // NSSC's own case: its row was gone from the portal by the time the report was run, so it is
  // known only from the ledger. That path must not print a thinner line than the other one.
  withDay((dir, quiet) => {
    const obs = createObservability(dir, quiet);
    for (let i = 1; i <= 3; i++) {
      obs.recordOutcome({ status: 'failed', symbol: 'GONE', fiscalPeriod: '2026Q4', error: 'wrong page' });
    }
    const r = reconcile(dir);
    assert.strictEqual(r.failed.length, 1);
    assert.strictEqual(r.failed[0].attempts, 3, 'the ledger-only path must carry the count too');
    assert.match(formatReconciliation(r).find((l) => l.includes('GONE')), /3 attempts/);
  });
});

check('instanceLock: the lock frees itself on every exit a process controls', () => {
  // Registered as an exit hook rather than only in the signal handlers, so it covers Ctrl+C,
  // a fatal error exiting non-zero, a config refusal, and simply running off the end. Verified
  // by running all three in child processes; asserted here on the mechanism itself.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-exitlock-'));
  acquireInstanceLock(dir, { pid: process.pid });
  assert.ok(fs.existsSync(lockPathFor(dir)));
  // What the exit hook does.
  releaseInstanceLock(dir, { pid: process.pid });
  assert.ok(!fs.existsSync(lockPathFor(dir)), 'exiting must leave no lock behind');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- runtime assets

check('send-shortcut.ps1 is where the code that shells out to it expects', () => {
  // This path is built with path.join and only used when a real call fires, so nothing else
  // here would notice it breaking - the first symptom would be every capture failing, live.
  // It has already been moved once (out of scripts/, where it looked like test scaffolding).
  const trigger = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'extensionTrigger.js'), 'utf8');
  const match = trigger.match(/const SEND_SHORTCUT_SCRIPT = (path\.join\([^)]*\));/);
  assert.ok(match, 'extensionTrigger.js no longer defines SEND_SHORTCUT_SCRIPT the expected way');

  const srcDir = path.join(__dirname, '..', '..', 'src');
  // eslint-disable-next-line no-eval -- evaluating our own source expression, with __dirname bound
  const resolved = eval(match[1].replace('__dirname', JSON.stringify(srcDir)));
  assert.ok(fs.existsSync(resolved), `extensionTrigger.js points at ${resolved}, which does not exist`);
});

// ---------------------------------------------------------------- cross-platform shortcut

// The shortcut is written once, in Windows SendKeys notation, and each platform's injector
// renders it its own way. This translation is the only part of the macOS path testable from a
// machine that is not a Mac - and getting it wrong sends a combination nothing listens for,
// which looks exactly like the keystroke never arriving.

check('shortcutKeys: the configured shortcut parses to the combination it means', () => {
  assert.deepStrictEqual(parseSendKeys('^+y'), { ctrl: true, shift: true, alt: false, key: 'y' });
  assert.deepStrictEqual(parseSendKeys('^y'), { ctrl: true, shift: false, alt: false, key: 'y' });
  assert.deepStrictEqual(parseSendKeys('%+t'), { ctrl: false, shift: true, alt: true, key: 't' });
  assert.strictEqual(describeShortcut(parseSendKeys('^+y')), 'Ctrl+Shift+Y');
  // Case of the key does not matter to the injector, so normalise it once here.
  assert.strictEqual(parseSendKeys('^+Y').key, 'y');
});

check('shortcutKeys: Ctrl stays Ctrl on macOS - it does NOT become Command', () => {
  // Confirmed live on the Mac minis: a manifest "Ctrl+Shift+Y" binds to the literal Control
  // key on macOS, and pressing Ctrl+Shift+Y opens the popup. Translating it to Command would
  // send a combination the extension is not listening for, and the resulting silence would be
  // indistinguishable from the injection having failed altogether.
  const mods = toAppleScriptModifiers(parseSendKeys('^+y'));
  assert.deepStrictEqual(mods, ['control down', 'shift down']);
  assert.ok(!mods.some((m) => m.includes('command')), 'Command must never appear in the translation');
});

check('shortcutKeys: the AppleScript argument vector matches what the script expects', () => {
  // Positional: key, control, shift, option - each modifier as "1" or "0", because AppleScript
  // cannot turn a string like "control down, shift down" back into the constants it needs.
  assert.deepStrictEqual(toAppleScriptArgs(parseSendKeys('^+y')), ['y', '1', '1', '0']);
  assert.deepStrictEqual(toAppleScriptArgs(parseSendKeys('%y')), ['y', '0', '0', '1']);
});

check('shortcutKeys: a shortcut that could never work is rejected at parse time', () => {
  // Better to fail on the first call with a clear message than to inject something inert and
  // spend the day wondering why the popup never opens.
  assert.throws(() => parseSendKeys(''), /empty/i);
  assert.throws(() => parseSendKeys('y'), /no modifiers/i);
  assert.throws(() => parseSendKeys('^{ENTER}'), /simple modifier sequence/i);
  assert.throws(() => parseSendKeys('^'), /no key/i);
});

check('preflight: both platforms answer the same question about the capture flag', () => {
  for (const build of [macCommand, windowsCommand]) {
    const c = build('9222');
    assert.ok(c.file && Array.isArray(c.args) && typeof c.interpret === 'function');
    // The port must appear in the command, or it would match somebody else's Chrome.
    assert.ok(JSON.stringify(c.args).includes('9222'));
  }
  const mac = macCommand('9222');
  assert.strictEqual(mac.interpret('').status, 'no-matching-chrome');
  assert.strictEqual(mac.interpret('/Applications/Chrome --remote-debugging-port=9222').status, 'missing-capture-flag');
  assert.strictEqual(
    mac.interpret('/Applications/Chrome --remote-debugging-port=9222 --auto-accept-this-tab-capture').status,
    'ok'
  );
  const win = windowsCommand('9222');
  assert.strictEqual(win.interpret('HAS_FLAG').status, 'ok');
  assert.strictEqual(win.interpret('MISSING_FLAG').status, 'missing-capture-flag');
  assert.strictEqual(win.interpret('NO_MATCH').status, 'no-matching-chrome');
});

check('the macOS injector script is present and takes the arguments we pass it', () => {
  // Same guard as send-shortcut.ps1: the path is only exercised on a real call, on a Mac, so
  // nothing else here would notice it going missing or its argument order changing.
  const script = path.join(__dirname, '..', '..', 'src', 'send-shortcut.applescript');
  assert.ok(fs.existsSync(script), 'src/send-shortcut.applescript is missing');
  const text = fs.readFileSync(script, 'utf8');
  assert.match(text, /on run argv/, 'must accept positional arguments');
  // The four values toAppleScriptArgs produces, in order.
  for (const item of ['item 1 of argv', 'item 2 of argv', 'item 3 of argv', 'item 4 of argv']) {
    assert.ok(text.includes(item), `script does not read ${item}`);
  }
  assert.match(text, /control down/, 'must be able to send Control');
  assert.ok(!/command down/.test(text), 'must never send Command - see shortcutKeys.js');
});

// The platform is a PARAMETER, not read from the host, so both branches are exercised wherever
// the suite runs. The first version of this test read process.platform and therefore only ever
// checked one branch - it passed on Windows and failed on the first Mac it met, reporting a
// fault in the code when the fault was in the test.
const SHORTCUT_CONFIG = { cdpUrl: 'http://localhost:9222' };

check('shortcut command: the Windows form is unchanged by the macOS branch', () => {
  // The Windows path is proven in production, so the whole vector is pinned rather than
  // spot-checked - adding macOS support must not perturb it by so much as an argument.
  const command = buildShortcutCommand('^+y', SHORTCUT_CONFIG, 'ACME Q2 2026', 'win32');
  assert.strictEqual(command.file, 'powershell.exe');
  assert.strictEqual(command.label, 'send-shortcut.ps1');
  assert.strictEqual(command.diagnosticsOnStderr, false, 'PowerShell logs to stdout');

  const args = command.args;
  assert.deepStrictEqual(args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']);
  assert.ok(args[5].endsWith('send-shortcut.ps1'), 'must point at the PowerShell injector');
  assert.deepStrictEqual(args.slice(6), ['-Port', '9222', '-Keys', '^+y', '-TitleHint', 'ACME Q2 2026']);

  // The hint is genuinely optional - it is omitted when a page has no title.
  assert.ok(!buildShortcutCommand('^+y', SHORTCUT_CONFIG, '', 'win32').args.includes('-TitleHint'));
});

check('shortcut command: the macOS form matches what the AppleScript expects', () => {
  const command = buildShortcutCommand('^+y', SHORTCUT_CONFIG, 'ACME Q2 2026', 'darwin');
  assert.strictEqual(command.file, 'osascript');
  assert.strictEqual(command.label, 'send-shortcut.applescript');
  assert.strictEqual(command.diagnosticsOnStderr, true, 'osascript logs to stderr');

  const args = command.args;
  assert.ok(args[0].endsWith('send-shortcut.applescript'), 'must point at the AppleScript injector');
  // key, control, shift, option, titleHint - the positional order the script reads.
  assert.deepStrictEqual(args.slice(1), ['y', '1', '1', '0', 'ACME Q2 2026']);
  assert.ok(!args.includes('powershell.exe'));

  // The hint is passed as an empty string rather than dropped: the script reads it positionally,
  // so omitting it would shift every argument after it.
  assert.deepStrictEqual(buildShortcutCommand('^+y', SHORTCUT_CONFIG, '', 'darwin').args.slice(1), ['y', '1', '1', '0', '']);
});

check('shortcut command: the two platforms send the SAME combination', () => {
  // Ctrl+Shift+Y on both. If these ever diverge, one platform is silently sending a
  // combination the extension is not listening for.
  const win = buildShortcutCommand('^+y', SHORTCUT_CONFIG, '', 'win32');
  const mac = buildShortcutCommand('^+y', SHORTCUT_CONFIG, '', 'darwin');
  assert.strictEqual(win.args[win.args.indexOf('-Keys') + 1], '^+y');
  assert.deepStrictEqual(mac.args.slice(1, 5), ['y', '1', '1', '0']); // y, ctrl, shift, no option
});

// ---------------------------------------------------------------- blind-state debounce

// Observed on the first Mac reboot: Chrome had been running for two seconds, the portal page
// had not finished rendering, and the very first poll read zero rows - producing a frightening
// ERROR about an expired session on a machine that was working perfectly. An alarm that cries
// wolf on every restart is how people learn to ignore the one that matters, and worse, the
// supervisor acts on these flags: a false noRows would have restarted a healthy watcher.

check('observability: a blind state is only reported once it has persisted', () => {
  withTempObs((obs, dir) => {
    const read = () => JSON.parse(fs.readFileSync(path.join(dir, 'heartbeat.json'), 'utf8')).warnings;
    const beat = (blindFor) =>
      obs.heartbeat({
        rowsSeen: 0, withLinks: 0, parseableTimes: 0, dueNow: 0, queueDepth: 0,
        openCallTabs: 0, chromeConnected: true,
        blindFor, blindPollsBeforeAlarm: 3,
      });

    // The page has not rendered yet - one poll, then two. Not an alarm.
    beat({ noRows: 1, noLinks: 0, noReadableTimes: 0 });
    assert.strictEqual(read().noRows, false, 'a single blank poll must not raise an alarm');
    beat({ noRows: 2, noLinks: 0, noReadableTimes: 0 });
    assert.strictEqual(read().noRows, false);

    // Still blank on the third: now it is real.
    beat({ noRows: 3, noLinks: 0, noReadableTimes: 0 });
    assert.strictEqual(read().noRows, true, 'a persistent blank table must raise the alarm');

    // Recovered - the counter resets, so the supervisor stops acting on it.
    beat({ noRows: 0, noLinks: 0, noReadableTimes: 0 });
    assert.strictEqual(read().noRows, false);
  });
});

check('observability: each blind state is debounced independently', () => {
  withTempObs((obs, dir) => {
    const read = () => JSON.parse(fs.readFileSync(path.join(dir, 'heartbeat.json'), 'utf8')).warnings;
    obs.heartbeat({
      rowsSeen: 200, withLinks: 0, parseableTimes: 0, dueNow: 0, queueDepth: 0,
      openCallTabs: 0, chromeConnected: true,
      blindFor: { noRows: 0, noLinks: 4, noReadableTimes: 1 },
      blindPollsBeforeAlarm: 3,
    });
    const w = read();
    assert.strictEqual(w.noRows, false, 'rows are fine');
    assert.strictEqual(w.noLinks, true, 'links have been missing long enough');
    assert.strictEqual(w.noReadableTimes, false, 'times have only just started failing');
  });
});

check('observability: without debounce data the old immediate behaviour still applies', () => {
  // Nothing else calls heartbeat(), but a caller that omitted blindFor should not silently
  // lose its alarms - it falls back to judging the current reading alone.
  withTempObs((obs, dir) => {
    obs.heartbeat({
      rowsSeen: 0, withLinks: 0, dueNow: 0, queueDepth: 0, openCallTabs: 0, chromeConnected: true,
    });
    const w = JSON.parse(fs.readFileSync(path.join(dir, 'heartbeat.json'), 'utf8')).warnings;
    assert.strictEqual(w.noRows, true);
  });
});

check('supervisor: it acts on the debounced flag, so a booting page is not a restart', () => {
  // The two halves have to agree. If the heartbeat said "blind" while the log said "still
  // loading", the supervisor would kill a healthy watcher every time the machine rebooted.
  const booting = { pid: 42, updatedAt: new Date().toISOString(), warnings: { noRows: false } };
  assert.strictEqual(blindReason(booting, { pid: 42 }), null);

  const genuinelyBlind = { pid: 42, updatedAt: new Date().toISOString(), warnings: { noRows: true } };
  assert.match(blindReason(genuinelyBlind, { pid: 42 }), /zero rows/);
});

// ---------------------------------------------------------------- is this really the call

// These are the ACTUAL page titles from the day this went wrong: 26 captures, of which 7 had no
// audio at all. Five were registration pages and two were company homepages, and every one of
// them recorded twenty minutes of silence while reporting success - which is worse than failing,
// because nothing downstream can tell that transcript from a real one.
//
// The titles are kept verbatim rather than paraphrased. They are the only evidence of what the
// check has to survive.
const REAL_CAPTURES = [
  // Genuinely in the call - all had a player.
  { symbol: 'MPCC.OL', fp: '2026Q2', title: 'MPC Container Ships Audiocast Q2 2026', player: true, want: true },
  { symbol: 'MPZZF', fp: '2026Q2', title: 'MPC Container Ships Audiocast Q2 2026', player: true, want: true },
  { symbol: 'SWON.SW', fp: '2026Q2', title: 'Webcast | SoftwareOne H1 2026 Results', player: true, want: true },
  { symbol: 'HDL', fp: '2026Q2', title: 'Super Hi Second Quarter 2026 Financial Results Conference Call', player: true, want: true },
  { symbol: 'TIGR', fp: '2026Q2', title: 'UP Fintech Holding Limited Q2 2026 Earnings Conference Call', player: true, want: true },
  { symbol: 'ANF', fp: '2026Q2', title: 'Abercrombie & Fitch Co. Second Quarter 2026 Earnings Conference Call', player: true, want: true },
  { symbol: 'BBWI', fp: '2026Q2', title: 'Q2 2026 Bath & Body Works Earnings Conference Call', player: true, want: true },
  { symbol: 'PLAB', fp: '2026Q3', title: 'Photronics Q2 - FY26 Earnings', player: true, want: true },
  { symbol: 'DY', fp: '2027Q2', title: 'Dycom Industries, Inc. Q2 2027 Results Conference Call', player: true, want: true },
  { symbol: 'KSS', fp: '2026Q2', title: "Q2 2026 Kohl's Corporation Earnings Conference Call - Q4", player: true, want: true },
  { symbol: 'SJM', fp: '2027Q1', title: 'Webcast | J.M. Smucker Co. FY27 Q1 Earnings Q&A Webcast', player: true, want: true },
  { symbol: 'TRMD', fp: '2026Q2', title: 'TORM Second Quarter 2026 Results - Q4', player: true, want: true },
  { symbol: 'VIG.VI', fp: '2026Q2', title: 'Webcast | Results for the first half-year 2026', player: true, want: true },
  { symbol: 'DCI', fp: '2026Q4', title: 'Donaldson Company Q4 FY26 Earnings Webcast - Q4', player: true, want: true },
  { symbol: 'WSM', fp: '2026Q2', title: 'Williams-Sonoma, Inc. Q2 2026 Earnings Conference Call - Q4', player: true, want: true },
  { symbol: 'NA.TO', fp: '2026Q3', title: 'National Bank of Canada Third Quarter 2026 Earnings Results', player: true, want: true },

  // The seven that recorded silence. No player on any of them.
  { symbol: '2390.HK', fp: '2026Q2', title: 'Conference Registration', player: false, want: false },
  { symbol: 'LI', fp: '2026Q2', title: 'Diamond Pass Registration', player: false, want: false },
  { symbol: 'LITB', fp: '2026Q2', title: 'Event Registration', player: false, want: false },
  { symbol: '2015.HK', fp: '2026Q2', title: 'Diamond Pass Registration', player: false, want: false },
  { symbol: 'JKS', fp: '2026Q2', title: 'Diamond Pass Registration', player: false, want: false },
  { symbol: 'MOV', fp: '2027Q2', title: 'Movado Group, Inc. Corporate Website Homepage', player: false, want: false },
  { symbol: 'SFL', fp: '2026Q2', title: 'Home', player: false, want: false },
];

check('pageRelevance: every one of the 26 real captures is judged correctly', () => {
  const wrong = [];
  for (const c of REAL_CAPTURES) {
    const verdict = judgeRelevance({
      title: c.title,
      url: 'https://provider.example/session',
      text: c.title,
      hasPlayer: c.player,
      symbol: c.symbol,
      year: c.fp.slice(0, 4),
      period: c.fp.slice(4),
    });
    if (verdict.accepted !== c.want) wrong.push(`${c.symbol}: ${JSON.stringify(c.title)} -> ${verdict.accepted}`);
  }
  assert.deepStrictEqual(wrong, [], `misjudged: ${wrong.join(' | ')}`);
});

check('pageRelevance: no player means nothing to record, whatever else matches', () => {
  // The load-bearing rule. A page can name the company AND the quarter and still be a
  // registration confirmation handing out a telephone number - Chorus Call's Diamond Pass does
  // exactly that, and no amount of waiting makes such a tab produce audio.
  const verdict = judgeRelevance({
    title: 'Abercrombie & Fitch Co. Q2 2026 Earnings Conference Call',
    url: 'https://provider.example/x',
    text: 'ANF Q2 2026 dial in 1-800-555-0100 PIN 4821',
    hasPlayer: false,
    symbol: 'ANF',
    year: '2026',
    period: 'Q2',
  });
  assert.strictEqual(verdict.accepted, false);
  assert.match(verdict.reason, /no audio or video player|telephone dial-in/);
});

check('pageRelevance: a registration title is refused even with a player on the page', () => {
  // Belt and braces: the title rule runs before the player rule, so a registration page that
  // happens to embed a video still cannot be mistaken for the call.
  for (const title of ['Diamond Pass Registration', 'Conference Registration', 'Event Registration', 'Home', 'Movado Group, Inc. Corporate Website Homepage']) {
    const v = judgeRelevance({ title, url: 'https://x.example/', text: title, hasPlayer: true, symbol: 'ANF', year: '2026', period: 'Q2' });
    assert.strictEqual(v.accepted, false, `should refuse: ${title}`);
  }
});

check('pageRelevance: a ticker must appear as a word, and short ones are not evidence alone', () => {
  // "LI" as a substring matches "public", "listen" and "quality", so a two-letter ticker made
  // almost any page look like the right one. That is how LI 2026Q2 accepted a registration page.
  assert.ok(!symbolAppearsAsWord('the public listen quality link', 'li'), 'substring must not count');
  assert.ok(symbolAppearsAsWord('welcome to the LI earnings call', 'li'), 'a whole word does');

  // Even as a word, two letters are not enough on their own - it needs the quarter or the year.
  const shortOnly = judgeRelevance({
    title: 'LI', url: 'https://x.example/s', text: 'LI', hasPlayer: true, symbol: 'LI', year: '2026', period: 'Q2',
  });
  assert.strictEqual(shortOnly.accepted, false, 'a bare two-letter ticker is not identification');

  // A longer ticker as a word is.
  const longer = judgeRelevance({
    title: 'TIGR investor session', url: 'https://x.example/s', text: 'TIGR', hasPlayer: true, symbol: 'TIGR', year: '2099', period: 'Q9',
  });
  assert.ok(longer.accepted);
  assert.match(longer.reason, /ticker "tigr" as a word/);
});

check('pageRelevance: a player with no identity at all is refused unless it is the portal link', () => {
  const base = { title: 'webinar.net', url: 'https://app.webinar.net/OM3bGdQ8gY1', text: 'webinar.net', hasPlayer: true, symbol: 'NSSC', year: '2026', period: 'Q4' };
  // Nothing ties it to the call, and it is not the host we were sent to.
  assert.strictEqual(judgeRelevance({ ...base, dialinUrl: 'https://elsewhere.example/x' }).accepted, false);
  // But NSSC 2026Q4's real page was exactly this, on exactly the host the portal gave us - a
  // legitimate player whose title names neither company nor quarter. It must still record.
  const onPortalHost = judgeRelevance({ ...base, dialinUrl: 'https://app.webinar.net/OM3bGdQ8gY1' });
  assert.ok(onPortalHost.accepted, 'the portal-supplied host with a player must be accepted');
  assert.match(onPortalHost.reason, /host the portal/);
});

// ---------------------------------------------------------------- retrying differently

// Retrying used to mean doing the same thing again. A day's log showed every failed call
// burning all four attempts and reporting the identical error each time - four attempts that
// were really one attempt tried four times.

check('retryStrategy: the first attempt is exactly what it always was', () => {
  // The single most important property here. Attempt 1 produced 19 good captures in a day; a
  // broader search is not a better one, it is a riskier one, and it must not leak backwards.
  const first = strategyForAttempt(1);
  assert.strictEqual(first.maxHops, BASE.maxHops);
  assert.strictEqual(first.ctaTextLimit, BASE.ctaTextLimit);
  assert.strictEqual(first.maxFormSteps, BASE.maxFormSteps);
  assert.strictEqual(first.allowFurniture, false);
  assert.strictEqual(first.tryAllButtons, false);
  assert.strictEqual(first.hrefPattern, null, 'link-shape matching is for later attempts only');
  assert.strictEqual(first.label, 'precise');
});

check('retryStrategy: each attempt searches strictly wider than the last', () => {
  const s = [1, 2, 3, 4].map(strategyForAttempt);
  // Monotonic: nothing narrows as attempts go up, or a later try could fail where an earlier
  // one would have succeeded.
  for (let i = 1; i < s.length; i++) {
    assert.ok(s[i].maxHops >= s[i - 1].maxHops, `hops narrowed at attempt ${i + 1}`);
    assert.ok(s[i].ctaTextLimit >= s[i - 1].ctaTextLimit, `CTA limit narrowed at attempt ${i + 1}`);
    assert.ok(s[i].maxFormSteps >= s[i - 1].maxFormSteps, `form steps narrowed at attempt ${i + 1}`);
  }
  // And each tier actually turns something on.
  assert.ok(s[1].allowFurniture && !s[0].allowFurniture, 'attempt 2 allows footer forms');
  assert.ok(s[2].hrefPattern && !s[1].hrefPattern, 'attempt 3 judges links by URL shape');
  assert.ok(s[2].tryAllButtons && !s[1].tryAllButtons, 'attempt 3 tries every button');
  assert.ok(s[3].ctaTextLimit > s[2].ctaTextLimit, 'attempt 4 accepts longer link text');
});

check('retryStrategy: widening finds link text and shapes precision rejects', () => {
  const a1 = strategyForAttempt(1);
  const a2 = strategyForAttempt(2);
  const a3 = strategyForAttempt(3);

  // Wording a first pass will not touch, but that really does lead to calls.
  for (const text of ['Listen to the conference call', 'Click here', 'Attend the event', 'Dial-in details']) {
    assert.ok(!a1.ctaPattern.test(text) || text.includes('conference call'), `attempt 1 should be strict about: ${text}`);
    assert.ok(a2.ctaPattern.test(text), `attempt 2 should accept: ${text}`);
  }

  // A link labelled uselessly whose URL says exactly what it is. Text-only matching can never
  // find these, and some providers label the real link with nothing but an icon or a date.
  assert.strictEqual(a1.hrefPattern, null);
  for (const path of ['/webcast/q2-2026', '/events/12345', '/live/session', '/attendee/9981']) {
    assert.ok(a3.hrefPattern.test(path), `attempt 3 should recognise: ${path}`);
  }
  // ...but still not a document or a corporate page, which other rules reject anyway.
  assert.ok(!a3.hrefPattern.test('/about-us'), 'shape matching must not resurrect corporate pages');
});

check('retryStrategy: nav wording broadens to where webcast links actually hide', () => {
  const a1 = strategyForAttempt(1);
  const a2 = strategyForAttempt(2);
  // Deliberately NOT matched first time round: too generic, and a wasted hop is a lost hop.
  for (const text of ['Investors', 'Financial Reports', 'Quarterly Results', 'Media']) {
    assert.ok(!a1.navPattern.test(text), `attempt 1 should skip: ${text}`);
    assert.ok(a2.navPattern.test(text), `attempt 2 should follow: ${text}`);
  }
  // The precise wording keeps working at every level.
  for (const s of [a1, a2]) assert.ok(s.navPattern.test('Events & Presentations'));
});

check('retryStrategy: beyond the cap it stops widening rather than doing something odd', () => {
  const fourth = strategyForAttempt(4);
  for (const n of [5, 9, 100]) {
    assert.deepStrictEqual(strategyForAttempt(n).maxHops, fourth.maxHops);
    assert.deepStrictEqual(strategyForAttempt(n).maxFormSteps, fourth.maxFormSteps);
  }
  // Nonsense in, first attempt out - never an undefined limit that would disable a bound.
  for (const bad of [0, -3, undefined, null, NaN, 'two']) {
    const s = strategyForAttempt(bad);
    assert.strictEqual(s.maxHops, BASE.maxHops, `bad input ${String(bad)} must fall back to attempt 1`);
  }
});

check('formFiller: field names separated by hyphens or underscores still match', () => {
  // q4inc's registration form uses analyst-first-name, analyst-last-name, analyst-company-name.
  // The patterns required whitespace between the words, so "last-name" matched nothing at all -
  // the field fell through to a geometric label guess, picked up its NEIGHBOUR's "First name"
  // because both sat on the same row, and the last-name box was filled with the first name.
  const expected = [
    ['analyst-first-name', 'firstName'], ['analyst-last-name', 'lastName'],
    ['analyst-company-name', 'company'], ['analyst-email', 'email'],
    ['analyst-phone-number', 'phone'],
    ['first_name', 'firstName'], ['last_name', 'lastName'],
    ['given-name', 'firstName'], ['family_name', 'lastName'], ['surname', 'lastName'],
  ];
  for (const [description, key] of expected) {
    assert.strictEqual(matchField(description), key, `${description} should match ${key}`);
  }
  // The separators must not widen what counts as a person's name.
  for (const description of ['file-name', 'user_name', 'screen-name', 'host-name']) {
    const got = matchField(description);
    assert.ok(got !== 'firstName' && got !== 'lastName' && got !== 'fullName', `${description} is not a person: got ${got}`);
  }
});

check('dispatchRules: a stream lost BEFORE the call starts is waited out, not restarted', () => {
  // The flow is join early, start recording, move on - so most captures begin before anyone
  // speaks. The extension stops a stream after about ten minutes of silence, so a call joined
  // at T-15 loses its stream around T-5 with nothing wrong. Restarting there spends an attempt
  // and lands in the same silence; four of those and the attempts are gone before the call has
  // even begun. That is what cost NVDA, CRWD and P their recordings.
  for (const minsLeft of [14, 10, 5, 2]) {
    const v = shouldReacquireNow({ minsLeft });
    assert.strictEqual(v.reacquire, false, `${minsLeft} min before the start must not restart`);
    assert.strictEqual(v.waiting, true, 'and it must say it is waiting, not that it gave up');
  }
});

check('dispatchRules: once the call is under way a lost stream is restarted at once', () => {
  // Here a missing stream means what it always meant, and every second of delay is lost audio.
  for (const minsLeft of [1, 0, -1, -10, -29]) {
    assert.strictEqual(shouldReacquireNow({ minsLeft }).reacquire, true, `${minsLeft} should restart`);
  }
});

check('dispatchRules: well past the start it is over, not worth restarting', () => {
  const v = shouldReacquireNow({ minsLeft: -31, reacquireGraceMinutes: 30 });
  assert.strictEqual(v.reacquire, false);
  assert.ok(!v.waiting, 'over is terminal, not waiting');
  assert.match(v.reason, /over/);
});

check('dispatchRules: the start threshold is configurable without changing the shape', () => {
  // A provider that opens its line five minutes early could reasonably restart sooner.
  assert.strictEqual(shouldReacquireNow({ minsLeft: 4, startsWithinMinutes: 5 }).reacquire, true);
  assert.strictEqual(shouldReacquireNow({ minsLeft: 6, startsWithinMinutes: 5 }).reacquire, false);
});

check('providerRules: a q4inc analyst link becomes the attendee webcast for the same event', () => {
  // Seven calls over three days were refused with "the page has no audio or video player", and
  // the refusal was right: /analyst/ registers for the telephone Q&A line and asks for "the
  // phone number you will call in from". The listen-only webcast is the same id under
  // /attendee/, which offers "Continue without a Q4 account" - a path the filler already
  // handles. Verified against the live page.
  const out = rewriteToWebcastUrl('https://events.q4inc.com/analyst/883220744?pwd=7dXQ6ZuG');
  assert.strictEqual(out.changed, true);
  assert.strictEqual(out.url, 'https://events.q4inc.com/attendee/883220744?pwd=7dXQ6ZuG');
  assert.match(out.why, /telephone/i);
});

check('providerRules: an attendee link is already right and is left alone', () => {
  // Rewriting twice would be harmless here, but a rule that fires on its own output is one
  // provider change away from a loop.
  const url = 'https://events.q4inc.com/attendee/883220744?pwd=7dXQ6ZuG';
  assert.strictEqual(rewriteToWebcastUrl(url).changed, false);
  assert.strictEqual(rewriteToWebcastUrl(url).url, url);
});

check('providerRules: an unknown provider passes through untouched', () => {
  const url = 'https://edge.media-server.com/mmc/p/9ygc48hy/';
  const out = rewriteToWebcastUrl(url);
  assert.strictEqual(out.changed, false);
  assert.strictEqual(out.url, url);
});

check('providerRules: Diamond Pass is named as telephone-only rather than retried', () => {
  // Four attempts on a page that can never carry audio cost the pipeline lock, and other calls
  // in the same 15-minute window queue behind it.
  for (const url of [
    'https://s1.c-conf.com/diamondpass/10056759-hu76t5.html',
    'https://dpregister.com/DiamondPassRegistration/register?confirmationNumber=10211387',
  ]) {
    const reason = telephoneOnlyReason(url);
    assert.ok(reason, `${url} should be recognised as telephone-only`);
    assert.match(reason, /dial-in|no browser stream/i);
  }
});

check('providerRules: a normal webcast link is not mistaken for telephone-only', () => {
  // The pattern must not fire on choruscall's actual WEBCAST host, which does carry audio -
  // ALWN 2026Q2 was recorded through it.
  assert.strictEqual(telephoneOnlyReason('https://webcast.choruscall.com/webcast.html?webcastid=R1WupLoR'), null);
  assert.strictEqual(telephoneOnlyReason('https://event.choruscall.com/mediaframe/webcast.html?webcastid=x'), null);
});

check('dispatchRules: a call that was recorded and finished is never reported as missed', () => {
  // FRO 2026Q2: joined fifteen minutes early, audio audible, written to the ledger as started,
  // transcript delivered. Its stream vanished when the call ended, the loop marked it
  // completed, and every poll afterwards announced "Missed FRO 2026Q2: attempted 1x without
  // success" - about a call that had worked perfectly. The ledger disagreed with reality in the
  // worst direction: under-reporting success invites fixing what was never broken.
  assert.strictEqual(
    shouldSkipAsLate({ minsLeft: -101, record: { status: 'completed', attempts: 1 } }),
    null
  );
});

check('dispatchRules: a call given up on is terminal too, not missed again every poll', () => {
  // markCompleted is also how "gave up reacquiring after 4 attempts" ends. That failure was
  // recorded when it happened; repeating it as a skipped-late entry adds nothing and double
  // counts one call.
  assert.strictEqual(
    shouldSkipAsLate({ minsLeft: -101, record: { status: 'completed', attempts: 4 } }),
    null
  );
});

check('dispatchRules: a call that really was never captured is still reported', () => {
  // The exemption must not swallow the case the warning exists for.
  const never = shouldSkipAsLate({ minsLeft: -101, record: null });
  assert.ok(never, 'a call with no record at all, past its start, is missed');
  assert.match(never.reason, /never attempted/);

  const tried = shouldSkipAsLate({ minsLeft: -101, record: { status: 'failed', attempts: 3 } });
  assert.ok(tried, 'a failed record past the start is missed');
  assert.match(tried.reason, /attempted 3x/);
});

// Bytes that must never appear in source: NUL, BACKSPACE, VERTICAL TAB, FORM FEED.
const CONTROL_CHARS = new RegExp('[' + ['\\u0000', '\\u0008', '\\u000b', '\\u000c'].join('') + ']');
const NEWLINE = String.fromCharCode(10);
const REPO_ROOT = require('path').join(__dirname, '..', '..');

check('no source file contains a stray control character', () => {
  // A whole class of silent bug, met twice, invisible both times.
  //
  // In a TEMPLATE LITERAL, \b is the BACKSPACE escape rather than a word boundary - so
  // `join (?:on|from) the web\b` compiled to a pattern ending in U+0008 that could never match
  // anything, and any provider wording its browser option "Join on the web" was invisible to us
  // for as long as that line existed. The same character later reached a regex LITERAL through
  // a scripted edit and killed the "slides?" alternative of STALE_BUTTON_PATTERN.
  //
  // Neither is visible when reading the file, neither fails a syntax check, and both simply make
  // a rule quietly stop applying. Reading the bytes is the only way to catch it.
  const fs = require('fs');
  const path = require('path');
  const offenders = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(full);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;
      const text = fs.readFileSync(full, 'utf8');
      const lines = text.split(NEWLINE);
      for (let index = 0; index < lines.length; index++) {
        // Tab, newline and carriage return are legitimate. These four never are.
        const found = CONTROL_CHARS.exec(lines[index]);
        if (!found) continue;
        const code = found[0].charCodeAt(0).toString(16).padStart(4, '0');
        offenders.push(path.relative(REPO_ROOT, full) + ':' + (index + 1) + ' contains U+' + code);
      }
    }
  };
  walk(path.join(REPO_ROOT, 'src'));
  walk(path.join(REPO_ROOT, 'scripts'));

  assert.deepStrictEqual(offenders, [], 'stray control characters: ' + offenders.join('; '));
});

check('the patterns that escape hazard broke actually match', () => {
  // Asserted on the exact wordings that silently stopped matching.
  assert.ok(BROWSER_ENTRY_PATTERN.test('Join on the web'), '"Join on the web" must be recognised');
  assert.ok(BROWSER_ENTRY_PATTERN.test('Join from the web'), '"Join from the web" must be recognised');
  assert.ok(BROWSER_ENTRY_PATTERN.test('Join from Your Browser'), 'the common wording must still work');
  assert.ok(NATIVE_APP_PATTERN.test('Join from Zoom Workplace app'), 'the app link must still be refused');
  assert.ok(
    !BROWSER_ENTRY_PATTERN.test('Join from Zoom Workplace app'),
    'and the app link must never be read as the browser one'
  );
});

check('providerRules: a news aggregator is refused before a tab is opened', () => {
  // kalkine.com.au carries nine calls in the book, and every one of its links is an ARTICLE
  // announcing that results are coming. The page has no webcast on it: stock tickers, a
  // "Download Free Report" lead magnet, nothing else. Verified by opening it.
  //
  // Refusing matters more than the missed call. The resolver follows a navigational link into
  // kalkine.com.au/get-three-stocks, which is a lead-capture form with First Name, Last Name,
  // Email and Mobile - so the filler fills it in and submits it. Nothing is recorded and an
  // address goes to a stock-tips funnel, four times per call.
  for (const url of [
    'https://kalkine.com.au/news/announcements/accent-group-to-release-fy26-full-year-results',
    'https://www.kalkine.com.au/get-three-stocks',
    'https://kalkine.com/news/anything',
  ]) {
    const reason = notAWebcastReason(url);
    assert.ok(reason, `${url} should be refused`);
    assert.match(reason, /news aggregator/i);
  }
});

check('providerRules: a real provider is not mistaken for an aggregator', () => {
  // The two verified by hand today, plus the busiest host in the book.
  for (const url of [
    'https://edge.media-server.com/mmc/p/abc/',
    'https://ccmediaframe.com/?id=SnteCPZ2',
    'https://qcnl.tv/p/rhBRgqODy-OksC0Co0hm8A',
    'https://event.choruscall.com/mediaframe/webcast.html?webcastid=x',
  ]) {
    assert.strictEqual(notAWebcastReason(url), null, `${url} must not be refused`);
  }
});

check('providerRules: a malformed link does not throw', () => {
  // A truncated or empty link reaches here on occasion; refusing is a judgement, not a parser.
  for (const url of ['', null, undefined, 'not-a-url', 'https://']) {
    assert.strictEqual(notAWebcastReason(url), null);
  }
});

check('providerRules: Diamond Pass covers every host shape it appears under', () => {
  // s1.c-conf.com carries twelve calls. They were already being refused, but only after four
  // attempts had each opened a tab to discover it - and those attempts hold the pipeline lock
  // that every other call in the window queues behind.
  for (const url of [
    'https://s1.c-conf.com/diamondpass/10055017-9xfr47.html',
    'https://s2.c-conf.com/diamondpass/x.html',
    'https://dpregister.com/DiamondPassRegistration/register?confirmationNumber=1',
  ]) {
    assert.ok(telephoneOnlyReason(url), `${url} should be known telephone-only`);
  }
  // And its webcast sibling, which does carry audio, must stay usable.
  assert.strictEqual(telephoneOnlyReason('https://webcast.choruscall.com/webcast.html?id=x'), null);
});

check('furniture paths: only the final segment decides', () => {
  const furniture = [
    'https://x.com/privacy-policy',
    'https://x.com/privacy',
    'https://x.com/terms-of-use',
    'https://x.com/support',
    'https://x.com/resources',
  ];
  const notFurniture = [
    'https://x.com/company/investors/webcast',
    'https://x.com/support/webcast/live',
    'https://x.com/about/events/q2-2026',
    'https://x.com/?event=123',
    'https://x.com/webcast',
  ];
  for (const url of furniture) assert.strictEqual(isFurniturePath(url), true, url);
  for (const url of notFurniture) assert.strictEqual(isFurniturePath(url), false, url);
});

// ------------------------------------------- provider content paths
check('provider paths: a YouTube link is only the call when it is a video', () => {
  const isCall = [
    'https://www.youtube.com/live/1VdQLNMxZh0',
    'https://www.youtube.com/watch?v=1VdQLNMxZh0',
    'https://youtube.com/embed/abc123',
    'https://www.youtube.com/v/abc123',
  ];
  const isNotCall = [
    'https://www.youtube.com/@AcmeInvestorRelations',
    'https://www.youtube.com/channel/UCxyz123',
    'https://www.youtube.com/c/AcmeCorp',
    'https://www.youtube.com/user/acme',
    'https://www.youtube.com/playlist?list=PL123',
    'https://www.youtube.com/results?search_query=acme+earnings',
    'https://www.youtube.com/feed/subscriptions',
    'https://www.youtube.com/shorts/abc123',
    'https://www.youtube.com/',
  ];
  for (const url of isCall) assert.strictEqual(isProviderNonContentPath(url), false, url);
  for (const url of isNotCall) assert.strictEqual(isProviderNonContentPath(url), true, url);
});

check('provider paths: hosts with no content rule are unaffected', () => {
  for (const url of [
    'https://edge.media-server.com/mmc/p/wwjhstmr/',
    'https://event.choruscall.com/mediaframe/webcast.html?webcastid=X',
    'https://app.webinar.net/zD8Z0G23Mjg',
    'https://us02web.zoom.us/j/83171321596',
  ]) {
    assert.strictEqual(isProviderNonContentPath(url), false, url);
  }
});

// -------------------------------------------------- start-aware retry schedule
check('retry: the old schedule spent every attempt before the call opened', () => {
  // The failure this exists to prevent, reconstructed. SLHN.SW 2026Q2: dispatched at T-15 for an
  // 07:00 call, four attempts between 06:45:39 and 06:51:18, none of them while the call was on
  // air. Filling the very same form after the event opened produced a playing video.
  const MIN = 60 * 1000;
  let elapsed = 0;
  const oldSchedule = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const delay = Math.min(30000 * 2 ** (attempt - 1), 10 * 60 * 1000);
    elapsed += delay;
    oldSchedule.push(elapsed);
  }
  // Last attempt at T-15 plus this much - still more than ten minutes before the call.
  assert.ok(oldSchedule[oldSchedule.length - 1] < 4 * MIN, 'all four attempts inside four minutes');
  assert.ok(15 * MIN - oldSchedule[oldSchedule.length - 1] > 10 * MIN, 'last attempt lands before T-10');
});

check('retry: attempts now fill the window and the last lands about a minute before the start', () => {
  const MIN = 60 * 1000;
  let msUntilStart = 15 * MIN;
  const landings = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const delay = retryDelayMsFor({ attempts: attempt, maxAttempts: 4, msUntilStart });
    msUntilStart -= delay;
    landings.push(msUntilStart / MIN);
  }
  // Three retries after the first attempt, ending close to - but not past - the start.
  assert.ok(landings[2] > 0, `last attempt must still be before the call (got T${landings[2].toFixed(1)})`);
  assert.ok(landings[2] <= 1.5, `last attempt should be near the start, got T-${landings[2].toFixed(1)} min`);
  // And strictly ordered, each one later than the last.
  assert.ok(landings[0] > landings[1] && landings[1] > landings[2], 'attempts must march towards the start');
});

check('retry: no attempt is scheduled at or past the start for any realistic window', () => {
  const MIN = 60 * 1000;
  for (let windowMin = 3; windowMin <= 60; windowMin++) {
    let msUntilStart = windowMin * MIN;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const delay = retryDelayMsFor({ attempts: attempt, maxAttempts: 4, msUntilStart });
      msUntilStart -= delay;
      assert.ok(
        msUntilStart >= 30 * 1000,
        `window ${windowMin} min: attempt ${attempt + 1} lands at T${(msUntilStart / MIN).toFixed(2)} min`
      );
    }
  }
});

check('retry: a window too small for four attempts is honestly out of room', () => {
  const MIN = 60 * 1000;
  const overshot = [];
  for (const windowMin of [1, 2, 3]) {
    let msUntilStart = windowMin * MIN;
    for (let attempt = 1; attempt <= 3; attempt++) {
      msUntilStart -= retryDelayMsFor({ attempts: attempt, maxAttempts: 4, msUntilStart });
    }
    if (msUntilStart <= 0) overshot.push(windowMin);
  }
  assert.deepStrictEqual(overshot, [1, 2], 'only the one- and two-minute windows may run out of room');
});

check('retry: never waits past the last useful moment even when the exponential is larger', () => {
  const delay = retryDelayMsFor({ attempts: 3, maxAttempts: 4, msUntilStart: 100 * 1000 });
  assert.ok(delay <= 70 * 1000, `expected the wait to be clamped, got ${delay}ms`);
  assert.ok(delay > 0);
});

check('retry: lateStartGraceMinutes actually extends the schedule', () => {
  const MIN = 60 * 1000;
  const lastLanding = (graceMin) => {
    let msUntilStart = 15 * MIN;
    for (let attempt = 1; attempt <= 3; attempt++) {
      msUntilStart -= retryDelayMsFor({
        attempts: attempt,
        maxAttempts: 4,
        msUntilStart,
        lateGraceMs: graceMin * MIN,
      });
    }
    return msUntilStart / MIN;
  };
  assert.ok(lastLanding(0) > 0, 'with no grace the last attempt stays before the start');
  assert.ok(lastLanding(3) < 0, 'with three minutes of grace it lands after the start');
  assert.ok(lastLanding(3) > -3, 'but still inside the grace it was given');
  assert.ok(lastLanding(5) < lastLanding(3), 'more grace lands later');
});

check('retry: falls back to the plain exponential when there is nothing to spread over', () => {
  // No schedule known, already under way, or out of attempts: unchanged behaviour.
  assert.strictEqual(retryDelayMsFor({ attempts: 1, maxAttempts: 4, msUntilStart: null }), 30000);
  assert.strictEqual(retryDelayMsFor({ attempts: 2, maxAttempts: 4, msUntilStart: null }), 60000);
  assert.strictEqual(retryDelayMsFor({ attempts: 1, maxAttempts: 4, msUntilStart: -5 * 60000 }), 30000);
  assert.strictEqual(retryDelayMsFor({ attempts: 4, maxAttempts: 4, msUntilStart: 15 * 60000 }), 240000);
  assert.strictEqual(retryDelayMsFor({ attempts: 1, maxAttempts: 4, msUntilStart: 30000 }), 30000);
});

check('retry: the exponential is the floor, so a transient failure is not made to wait', () => {
  // A wide window must not turn a 30-second retry into a ten-minute one for no reason: the spread
  // only ever ADDS patience where the old cadence would have run out of attempts too early.
  const delay = retryDelayMsFor({ attempts: 1, maxAttempts: 4, msUntilStart: 4 * 60000 });
  assert.ok(delay >= 30000, 'never shorter than the base delay');
  assert.ok(delay <= 10 * 60 * 1000, 'never longer than the cap');
});

// ------------------------------------------------- drift within a provider
check('relevance: refuses a different event on the same provider', () => {
  // MDT 2027Q1. The portal pointed at Medtronic's video; resolution ended on Alphabet's, and
  // "a player, and Q1" was enough to accept it. The transcript was filed as a success.
  const verdict = judgeRelevance({
    title: 'Alphabet 2026 Q1 Earnings Call - YouTube',
    url: 'https://www.youtube.com/live/LPJoiDiVkTI',
    hasPlayer: true,
    symbol: 'MDT',
    year: '2027',
    period: 'Q1',
    dialinUrl: 'https://www.youtube.com/live/1VdQLNMxZh0',
  });
  assert.strictEqual(verdict.accepted, false);
  assert.match(verdict.reason, /different event on the same provider/);
});

check('relevance: same event on the same provider is not a drift', () => {
  const verdict = judgeRelevance({
    title: 'Medtronic Q1 FY2027 Earnings Call - YouTube',
    url: 'https://www.youtube.com/live/1VdQLNMxZh0',
    hasPlayer: true,
    symbol: 'MDT',
    year: '2027',
    period: 'Q1',
    dialinUrl: 'https://www.youtube.com/live/1VdQLNMxZh0',
  });
  assert.strictEqual(verdict.accepted, true);
});

check('drift: real provider journeys that must NOT be called drifts', () => {
  // Every one of these is a move the providers actually make, taken from captures that worked.
  // A rule that refuses any of them would lose calls that are currently recorded.
  const journeys = [
    // Zoom keeps the meeting id when it swaps to the web client.
    ['https://us02web.zoom.us/j/83171321596?pwd=qpoCCe0T8xBEsZvO4Tn5bwnQk33BxL.1',
     'https://us02web.zoom.us/wc/83171321596/join'],
    // Chorus Call keeps the webcastid through registration.
    ['https://event.choruscall.com/mediaframe/webcast.html?webcastid=8agceY7Q',
     'https://event.choruscall.com/mediaframe/thankYou?webcastid=8agceY7Q'],
    // media-server appends a fragment and a trailing slash.
    ['https://edge.media-server.com/mmc/p/wwjhstmr/',
     'https://edge.media-server.com/mmc/p/wwjhstmr/#Presentation_6'],
    // Leaving the host entirely is the normal IR-page case, not a drift.
    ['https://www.corpcam.com/Sasol01092026',
     'https://presentations.corpcam.com/RegistrationPage.aspx?id=Sasol01092026'],
    // A dial-in link with no identifier at all cannot be drifted from.
    ['https://example.com/investors', 'https://example.com/events/q2-2026-webcast'],
    // Ordinary hops on a company's own site. None of these keeps a token, and refusing them
    // would lose calls that resolution currently finds.
    ['https://www.company.com/investor-relations', 'https://www.company.com/events/q2-2026-earnings'],
    ['https://ir.company.com/ir/2026-half-year-results', 'https://ir.company.com/webcasts/live-audio'],
    ['https://www.company.com/news-events/events', 'https://www.company.com/quarterly-results/q2-fy26'],
    ['https://www.company.com/financial-reports', 'https://www.company.com/presentations/interim-2026'],
    // q4inc's analyst-to-attendee rewrite keeps the event id.
    ['https://events.q4inc.com/analyst/2026-q2-847392', 'https://events.q4inc.com/attendee/2026-q2-847392'],
    ['https://company.com/events/detail/88420190', 'https://company.com/webcast/live'],
    ['https://company.com/ir/event/20260901234', 'https://company.com/live-audio'],
    ['https://ir.company.com/detail/2026090112345', 'https://ir.company.com/webcast'],
  ];
  for (const [dial, landed] of journeys) {
    assert.strictEqual(driftedWithinHost(landed, dial), false, `${dial} -> ${landed}`);
  }
});

check('drift: two different events on one provider are caught', () => {
  const pairs = [
    ['https://www.youtube.com/live/1VdQLNMxZh0', 'https://www.youtube.com/live/LPJoiDiVkTI'],
    [
      'https://event.choruscall.com/mediaframe/webcast.html?webcastid=8agceY7Q',
      'https://event.choruscall.com/mediaframe/webcast.html?webcastid=Uuzx0erS',
    ],
    ['https://edge.media-server.com/mmc/p/wwjhstmr/', 'https://edge.media-server.com/mmc/p/oc2xc3d6/'],
  ];
  for (const [dial, landed] of pairs) {
    assert.strictEqual(driftedWithinHost(landed, dial), true, `${dial} -> ${landed}`);
  }
});

check('drift: a different id on the same host IS a drift', () => {
  assert.strictEqual(
    driftedWithinHost('https://www.youtube.com/live/LPJoiDiVkTI', 'https://www.youtube.com/live/1VdQLNMxZh0'),
    true
  );
  assert.strictEqual(
    driftedWithinHost(
      'https://event.choruscall.com/mediaframe/webcast.html?webcastid=Uuzx0erS',
      'https://event.choruscall.com/mediaframe/webcast.html?webcastid=8agceY7Q'
    ),
    true
  );
});

// ---------------------------------------------------------------- sharding
const at = (h, m) => new Date(2026, 8, 3, h, m).getTime();
const callRow = (symbol, hour, minute, link) => ({
  symbol,
  fiscalPeriod: '2026Q2',
  earningsDate: '2026-09-03',
  dialinLink: link || `https://edge.media-server.com/mmc/p/${symbol.toLowerCase()}/`,
  dueAt: at(hour, minute),
});

check('shard: with one machine, every call is owned', () => {
  const shard = readShard({});
  assert.strictEqual(shard.count, 1);
  for (const row of [callRow('AAPL', 9, 0), callRow('MSFT', 9, 0), callRow('BP.L', 14, 30)]) {
    assert.strictEqual(ownsRow(row, shard), true);
  }
});

check('shard: every call is owned by exactly one machine, at any count', () => {
  // The property the whole design rests on. No coordination between machines means coverage has
  // to fall out of arithmetic: miss it and calls are dropped or recorded twice, silently.
  const rows = [];
  for (let hour = 6; hour < 23; hour++) {
    for (const symbol of ['AAPL', 'MSFT', '601939.SS', 'CICHY', 'BP.L', 'CM.TO', 'ZIP.AX']) {
      rows.push(callRow(symbol, hour, (hour * 7) % 60));
    }
  }
  for (const count of [1, 2, 3, 4, 7]) {
    for (const row of rows) {
      const owners = [];
      for (let index = 0; index < count; index++) {
        if (ownsRow(row, { index, count })) owners.push(index);
      }
      assert.strictEqual(owners.length, 1, `${row.symbol} at count ${count} owned by ${owners.length} machines`);
    }
  }
});

check('shard: the owner does not change when OTHER rows come and go', () => {
  // Interleaving by list position - machine A takes the 1st, 3rd, 5th row - is the scheme that
  // can both double-record and miss, because positions shift as calls leave the window and as
  // the portal fills in a link mid-morning. A call that was 3rd becomes 2nd and changes owner.
  // Nothing here may depend on the shape of the list.
  const target = callRow('MSFT', 9, 30);
  const owner = shardIndexFor(target, 2);
  for (const others of [[], [callRow('AAPL', 8, 0)], [callRow('AAPL', 8, 0), callRow('BP.L', 9, 0)]]) {
    const list = [...others, target, ...others];
    for (const row of list) shardIndexFor(row, 2); // order of evaluation must not matter either
    assert.strictEqual(shardIndexFor(target, 2), owner, 'the owner must depend only on the call');
  }
});

check('shard: the owner does not depend on the clock in any way', () => {
  // The bug this exists to prevent, caught on two live machines before either started.
  //
  // The first version added the call's scheduled minute to spread same-minute bursts. dueAt is
  // RECONSTRUCTED from the portal's countdown text plus the current time, so two machines
  // polling a second apart landed on 659 and 660 - and every single owner flipped. Machine 6
  // and machine 7 would each have recorded the other's entire share.
  //
  // Same call, wildly different dueAt, and no dueAt at all: one answer.
  const link = 'https://event.choruscall.com/mediaframe/webcast.html?id=abc';
  const base = { symbol: 'SLHN.SW', fiscalPeriod: '2026Q2', dialinLink: link };
  const owners = new Set([
    shardIndexFor({ ...base, dueAt: new Date(2026, 8, 1, 6, 59, 58).getTime() }, 2),
    shardIndexFor({ ...base, dueAt: new Date(2026, 8, 1, 7, 0, 2).getTime() }, 2),
    shardIndexFor({ ...base, dueAt: new Date(2027, 0, 1, 23, 59).getTime() }, 2),
    shardIndexFor(base, 2),
  ]);
  assert.strictEqual(owners.size, 1, 'the clock must not change who owns a call');
});

check('shard: the owner survives the portal changing a link', () => {
  // The second bug this rule had, caught the same way - by comparing the preview across both
  // machines. CANG 2026Q2 read as ir.cangoonline.com on one and event.choruscall.com on the
  // other, because the portal updated its link between the two reads, and the owner flipped.
  //
  // Everything about a row can change while the day runs except the call's identity, so the key
  // is symbol + fiscal period + earnings date - the same key the state store dedupes on.
  const call = { symbol: 'CANG', fiscalPeriod: '2026Q2', earningsDate: '2026-09-01' };
  const owners = new Set([
    shardIndexFor({ ...call, dialinLink: 'https://ir.cangoonline.com/news-events/x' }, 2),
    shardIndexFor({ ...call, dialinLink: 'https://event.choruscall.com/mediaframe/y' }, 2),
    shardIndexFor({ ...call, dialinLink: '-' }, 2),
    shardIndexFor(call, 2),
  ]);
  assert.strictEqual(owners.size, 1, 'a link change must not move a call to another machine');
});

check('shard: the same symbol in different quarters can land on different machines', () => {
  // The key includes the period and the date, so each call is assigned on its own rather than
  // every quarter of a symbol piling onto one machine.
  const owners = new Set();
  for (const period of ['2026Q1', '2026Q2', '2026Q3', '2026Q4', '2027Q1', '2027Q2']) {
    owners.add(shardIndexFor({ symbol: 'AAPL', fiscalPeriod: period, earningsDate: '2026-09-03' }, 2));
  }
  assert.strictEqual(owners.size, 2, 'quarters of one symbol should not all share a machine');
});

check('shard: a same-minute burst is spread across machines', () => {
  // Calls cluster on the hour, so a burst must not land on one machine. Different calls have
  // different identities, which is what spreads them.
  const owners = new Set();
  for (const symbol of ['AAPL', 'MSFT', 'GOOG', 'AMZN', 'META', 'TSLA', 'NVDA', 'NFLX']) {
    owners.add(shardIndexFor(callRow(symbol, 21, 0), 2));
  }
  assert.strictEqual(owners.size, 2, 'a burst of eight at the same minute must reach both machines');
});

check('shard: a row with no scheduled time is still assigned deterministically', () => {
  // It will be discarded by the window check anyway, but two machines must not disagree about it
  // in a log.
  const row = { symbol: 'ECOR.L', fiscalPeriod: '2026Q2', dialinLink: 'https://x/y' };
  const first = shardIndexFor(row, 3);
  assert.strictEqual(shardIndexFor(row, 3), first);
  assert.ok(first >= 0 && first < 3);
});

check('shard: a misconfigured pair of machines is refused, not guessed at', () => {
  // The one mistake that silently drops calls: two machines with the same index take the same
  // half and nobody takes the rest, and nothing about it looks like an error.
  assert.throws(() => readShard({ shard: { index: 2, count: 2 } }), /between 0 and 1/);
  assert.throws(() => readShard({ shard: { index: -1, count: 2 } }), /between 0 and 1/);
  assert.throws(() => readShard({ shard: { index: 0, count: 0 } }), /1 or more/);
  assert.throws(() => readShard({ shard: { index: 0, count: 1.5 } }), /whole number/);
  assert.throws(() => readShard({ shard: { index: 'a', count: 2 } }), /shard.index/);
});

check('shard: the description names the machine in human terms', () => {
  assert.match(describeShard(readShard({})), /off/i);
  assert.match(describeShard(readShard({ shard: { index: 1, count: 3 } })), /Shard 2 of 3/);
});

// ---------------------------------------------------------------- report

(async () => {
  for (const { name, fn } of asyncChecks) {
    try {
      await fn();
      passed++;
    } catch (err) {
      failures.push(`${name}: ${err.message}`);
    }
  }
  for (const f of failures) console.error(`FAIL ${f}`);
  console.log(`${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
