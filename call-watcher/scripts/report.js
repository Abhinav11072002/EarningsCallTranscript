// Prints the day's reconciliation without stopping the watcher.
//
// The shutdown summary already prints this, but that only helps if you are the one stopping it.
// This lets you check "did we get everything so far today?" at any moment, from a second
// terminal, while the watcher keeps running - which is the question that actually gets asked
// mid-morning during earnings season.
//
// Usage:
//   npm run report              today
//   npm run report -- 2026-08-21   a specific day
const path = require('path');
const { reconcile, formatReconciliation } = require('../src/reconciliation');
const { createObservability } = require('../src/observability');

const DATA_DIR = path.join(__dirname, '..', 'data');

const arg = process.argv[2];
let when = new Date();
if (arg) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(arg);
  if (!m) {
    console.error(`Usage: npm run report -- [YYYY-MM-DD]   (got "${arg}")`);
    process.exit(1);
  }
  // Local noon, so the day stamp cannot slide across a timezone boundary.
  when = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
}

const quiet = { info() {}, warn() {}, error() {} };
const summary = createObservability(DATA_DIR, quiet).summarize(when);

const report = reconcile(DATA_DIR, when);

console.log('');
// Counts are per CALL, matching the reconciliation block below. They used to be per attempt
// here and per call there, so the same day was described by two different numbers.
console.log(`Calls on ${summary.date}: started=${summary.started.length} failed=${summary.failed.length} ` +
  `skipped-late=${summary.skippedLate.length} recovered-on-retry=${summary.retriedThenStarted.length}`);
for (const s of summary.started) {
  const late = (s.lateBySec ?? 0) > 60 ? `  (started ${s.lateBySec}s late)` : '';
  console.log(`  OK       ${s.label}${late}`);
}
// Detail for failures comes from the reconciliation block below, which covers strictly more
// (including calls that produced no ledger entry at all) and reports one line per call.


console.log('');
for (const line of formatReconciliation(report)) console.log(line);

if (report.totalSeen === 0) {
  console.log('');
  console.log('No rows were observed for this date - either the watcher did not run, or the');
  console.log('seen log has aged out. Nothing can be concluded about coverage from this.');
}
// Non-zero exit when something reached the window and left no trace: makes this usable as a
// check from a scheduled task rather than only by eye.
process.exit(report.unaccounted.length ? 2 : 0);
