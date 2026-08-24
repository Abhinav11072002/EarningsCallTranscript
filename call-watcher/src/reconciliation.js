const fs = require('fs');
const path = require('path');

// Answers the one question the rest of the system cannot: "did we get everything today?"
//
// The outcomes ledger records what was ATTEMPTED - started, failed, skipped-late. That makes
// every attempt auditable, but it is silent about the failures that never became an attempt at
// all, which are exactly the ones nobody notices:
//
//   - a row whose Transcription Time could not be parsed, so it never became due
//   - a row that never had a dial-in link
//   - a row that entered the window and, through some gap, was simply never dispatched
//
// None of those produce a ledger entry. A day where twenty calls silently never became due
// looks, in the ledger, exactly like a quiet day. So this keeps an independent record of every
// row the watcher OBSERVED, and reconciles the two at shutdown or on demand. Every symbol ends
// up in exactly one bucket, and the total is checkable against the portal by eye.
//
// Written as a plain JSON map keyed the same way as the dedupe store, rewritten in place - it
// is small (one entry per call per day) and is not on the hot path.

function dayStamp(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function seenPathFor(dataDir, now = new Date()) {
  return path.join(dataDir, `seen-${dayStamp(now)}.json`);
}

class SeenLog {
  constructor(dataDir, logger, now = new Date()) {
    this.dataDir = dataDir;
    this.logger = logger;
    this.filePath = seenPathFor(dataDir, now);
    this.entries = new Map();
    this.dirty = false;
    try {
      this.entries = new Map(Object.entries(JSON.parse(fs.readFileSync(this.filePath, 'utf8'))));
    } catch {
      this.entries = new Map(); // first poll of the day
    }
  }

  // Called for every row on every poll. Only the transitions are interesting, so an entry is
  // written once and then only upgraded - a row that was once inside the window stays marked as
  // such even after its countdown has passed and the portal has dropped it.
  observe({ key, symbol, fiscalPeriod, earningsDate, hasLink, timeParsed, insideWindow }) {
    const existing = this.entries.get(key);
    const next = {
      symbol,
      fiscalPeriod,
      earningsDate,
      firstSeenAt: existing ? existing.firstSeenAt : new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      // Sticky: "did this row EVER have a link / a readable time / reach the window".
      everHadLink: Boolean(existing && existing.everHadLink) || Boolean(hasLink),
      everParsedTime: Boolean(existing && existing.everParsedTime) || Boolean(timeParsed),
      everInsideWindow: Boolean(existing && existing.everInsideWindow) || Boolean(insideWindow),
    };
    if (
      existing &&
      existing.everHadLink === next.everHadLink &&
      existing.everParsedTime === next.everParsedTime &&
      existing.everInsideWindow === next.everInsideWindow
    ) {
      // Nothing changed but the timestamp; keep it in memory and let the periodic flush write
      // it, rather than doing file I/O on every row of every poll.
      this.entries.set(key, next);
      this.dirty = true;
      return;
    }
    this.entries.set(key, next);
    this.dirty = true;
  }

  flush() {
    if (!this.dirty) return;
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const tempPath = `${this.filePath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(Object.fromEntries(this.entries), null, 2));
      fs.renameSync(tempPath, this.filePath);
      this.dirty = false;
    } catch (err) {
      // Never let bookkeeping kill the run.
      if (this.logger) this.logger.warn(`Could not write the seen log: ${err.message}`);
    }
  }

  size() {
    return this.entries.size;
  }
}

function readJsonl(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A truncated final line (killed mid-append) must not lose the whole day's ledger.
    }
  }
  return out;
}

// Buckets every observed call. The invariant worth stating out loud: the buckets are disjoint
// and every seen row lands in exactly one, so `total` always equals the sum of the parts. If it
// ever does not, this function is wrong and the report should not be trusted.
function reconcile(dataDir, now = new Date()) {
  const stamp = dayStamp(now);
  let seen = {};
  try {
    seen = JSON.parse(fs.readFileSync(seenPathFor(dataDir, now), 'utf8'));
  } catch {
    seen = {};
  }
  const outcomes = readJsonl(path.join(dataDir, `outcomes-${stamp}.jsonl`));

  const byLabel = new Map();
  for (const entry of outcomes) {
    const label = `${entry.symbol} ${entry.fiscalPeriod}`;
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label).push(entry);
  }

  const buckets = {
    recorded: [],
    failed: [],
    missedLate: [],
    noReadableTime: [],
    noDialinLink: [],
    // The bucket that exists only because of this report: it entered the window, had a link and
    // a readable time, and yet the ledger has nothing to say about it.
    unaccounted: [],
    notDueToday: [],
  };

  // Union, not just the seen log. A call attempted earlier in the day whose row has since left
  // the portal - which is what happens to every call once it starts - has a ledger entry and no
  // current seen entry, and reporting "recorded=0" while the ledger plainly shows a successful
  // capture is worse than not reporting at all. Observed exactly that on the first real run.
  const seenLabels = new Set(Object.values(seen).map((r) => `${r.symbol} ${r.fiscalPeriod}`));
  const ledgerOnly = [];
  for (const [label, entries] of byLabel) {
    if (seenLabels.has(label)) continue;
    const statuses = new Set(entries.map((e) => e.status));
    if (statuses.has('started')) buckets.recorded.push({ key: label, label });
    else if (statuses.has('skipped-late')) buckets.missedLate.push({ key: label, label });
    else if (statuses.has('failed')) {
      const last = entries.filter((e) => e.status === 'failed').pop() || {};
      buckets.failed.push({ key: label, label, error: last.error });
    }
    ledgerOnly.push(label);
  }

  for (const [key, row] of Object.entries(seen)) {
    const label = `${row.symbol} ${row.fiscalPeriod}`;
    const entries = byLabel.get(label) || [];
    const statuses = new Set(entries.map((e) => e.status));

    if (statuses.has('started')) {
      buckets.recorded.push({ key, label });
    } else if (statuses.has('skipped-late')) {
      buckets.missedLate.push({ key, label, error: (entries.find((e) => e.status === 'skipped-late') || {}).reason });
    } else if (statuses.has('failed')) {
      const last = entries.filter((e) => e.status === 'failed').pop() || {};
      buckets.failed.push({ key, label, error: last.error });
    } else if (!row.everHadLink) {
      buckets.noDialinLink.push({ key, label });
    } else if (!row.everParsedTime) {
      buckets.noReadableTime.push({ key, label });
    } else if (row.everInsideWindow) {
      buckets.unaccounted.push({ key, label });
    } else {
      // Seen on the table but never within the threshold - a call for a later day. Expected,
      // and counted only so the totals add up.
      buckets.notDueToday.push({ key, label });
    }
  }

  return {
    date: stamp,
    // Everything the report accounts for: rows observed today, plus calls the ledger knows
    // about whose rows have since left the table.
    totalSeen: Object.keys(seen).length + ledgerOnly.length,
    rowsObserved: Object.keys(seen).length,
    fromLedgerOnly: ledgerOnly.length,
    totalOutcomes: outcomes.length,
    ...buckets,
  };
}

// One block, ordered so the things that need action come first and the routine bulk last.
function formatReconciliation(report) {
  const lines = [];
  const n = (b) => report[b].length;
  lines.push(
    `Reconciliation for ${report.date}: ${report.totalSeen} call(s) observed | ` +
      `recorded=${n('recorded')} failed=${n('failed')} missed-late=${n('missedLate')} ` +
      `unaccounted=${n('unaccounted')} no-link=${n('noDialinLink')} ` +
      `unreadable-time=${n('noReadableTime')} not-due-today=${n('notDueToday')}`
  );
  // Loudest first: a call that reached the window and left no trace is the failure this whole
  // report exists to surface.
  for (const r of report.unaccounted) {
    lines.push(`  UNACCOUNTED  ${r.label} - entered the window with a usable link, but nothing was ever recorded about it`);
  }
  for (const r of report.missedLate) lines.push(`  MISSED-LATE  ${r.label}${r.error ? ` (${r.error})` : ''}`);
  for (const r of report.failed) lines.push(`  FAILED       ${r.label}: ${r.error || 'no error recorded'}`);
  for (const r of report.noReadableTime) lines.push(`  NO-TIME      ${r.label} - Transcription Time never parsed`);
  return lines;
}

module.exports = { SeenLog, reconcile, formatReconciliation, seenPathFor, dayStamp };
