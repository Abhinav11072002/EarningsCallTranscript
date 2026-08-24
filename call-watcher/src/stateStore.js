const fs = require('fs');
const path = require('path');

const DEFAULT_RECORD_TTL_DAYS = 7;

class StateStore {
  constructor(filePath, recordTtlDays = DEFAULT_RECORD_TTL_DAYS) {
    this.filePath = filePath;
    this.recordTtlMs = recordTtlDays * 24 * 60 * 60 * 1000;
    this.records = new Map();
    this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        // Legacy format: a bare list of keys. Stamped with "now" so the TTL sweep ages them out
        // over the normal window instead of deleting them on the very first load (which would
        // drop a record for a call that is still in progress).
        const migratedAt = new Date().toISOString();
        for (const key of data) this.records.set(key, { status: 'started', attempts: 1, updatedAt: migratedAt });
      } else {
        this.records = new Map(Object.entries(data));
      }
    } catch {
      this.records = new Map();
    }
    this.pruneExpired();
  }

  // Records are keyed by symbol|period|earningsDate, so they can never be replayed once the
  // date has passed - but they were also never removed, so the file and the in-memory Map grew
  // forever. For a process intended to run indefinitely that is an unbounded leak, so anything
  // older than the TTL is dropped on load and on each daily sweep.
  pruneExpired(now = Date.now()) {
    let removed = 0;
    for (const [key, record] of [...this.records]) {
      const stamp = record && record.updatedAt ? Date.parse(record.updatedAt) : NaN;
      // Legacy records carry no timestamp; treat them as expired so they age out once.
      if (Number.isNaN(stamp) || now - stamp > this.recordTtlMs) {
        this.records.delete(key);
        removed++;
      }
    }
    if (removed) this._save();
    return removed;
  }

  _save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(Object.fromEntries(this.records), null, 2));
    fs.renameSync(tempPath, this.filePath);
  }

  get(key) {
    return this.records.get(key) || null;
  }

  claim(key) {
    const previous = this.records.get(key);
    const record = {
      status: 'claimed',
      attempts: (previous?.attempts || 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    this.records.set(key, record);
    this._save();
    return record;
  }

  markStarted(key) {
    const record = this.records.get(key);
    if (!record) return;
    // absentObservations is cleared on purpose: the stream being visible again means any earlier
    // absence was a blip, and a stale tally must not accumulate toward "the call has finished".
    this.records.set(key, {
      ...record,
      status: 'started',
      absentObservations: 0,
      updatedAt: new Date().toISOString(),
    });
    this._save();
  }

  // Counts consecutive polls on which the extension did not list this call's stream. Used to
  // require confirmation before treating a call as finished, because the storage list can be
  // cleared mid-call by an extension reload and acting on one reading would end a live capture.
  noteAbsent(key, absences) {
    const record = this.records.get(key);
    if (!record) return;
    this.records.set(key, { ...record, absentObservations: absences, updatedAt: new Date().toISOString() });
    this._save();
  }

  // Terminal state: this call ran and is over. Needed because "was started, and its stream is
  // no longer active" is ambiguous - it means either "stopped by hand, reacquire it" or "the
  // call ended normally". Without a terminal state the second case was indistinguishable from
  // the first, so a finished call was re-recorded on every poll for the rest of the retry
  // window (up to 2 hours), producing duplicate transcripts and a new tab each time.
  markCompleted(key, reason) {
    const record = this.records.get(key) || {};
    this.records.set(key, {
      ...record,
      status: 'completed',
      completedReason: reason,
      updatedAt: new Date().toISOString(),
    });
    this._save();
  }

  fail(key, error, retryDelayMs) {
    const record = this.records.get(key) || { attempts: 1 };
    this.records.set(key, {
      ...record,
      status: 'failed',
      lastError: error,
      nextAttemptAt: new Date(Date.now() + retryDelayMs).toISOString(),
      updatedAt: new Date().toISOString(),
    });
    this._save();
  }

  retryDue(key, claimTimeoutMs = 30 * 60 * 1000) {
    const record = this.records.get(key);
    if (!record) return true;
    if (record.status === 'claimed') {
      return !record.updatedAt || Date.parse(record.updatedAt) + claimTimeoutMs <= Date.now();
    }
    if (record.status !== 'failed') return false;
    return !record.nextAttemptAt || Date.parse(record.nextAttemptAt) <= Date.now();
  }

  // Gives calls that burned through every attempt one more full set, and returns what it
  // reset so the operator can see it.
  //
  // Why a restart is the right trigger: the attempt cap is there to stop a call retrying
  // forever inside one session, and it should keep doing that. But once the process is
  // restarted - almost always because something was just fixed or reconfigured - the old
  // verdict was reached by code that no longer exists. Observed exactly this: NSSC 2026Q4
  // failed four times against a relevance check that was too strict, the check was corrected
  // minutes later, and the call still could not be retried because the record said "failed,
  // attempts=4". The fix was live and unreachable at the same time.
  //
  // This cannot turn into an infinite retry loop: index.js still refuses to start a call more
  // than lateStartGraceMinutes past its scheduled time, so a crash-restart cycle runs out of
  // eligible calls on its own.
  resetExhaustedFailures(maxAttempts) {
    const reset = [];
    for (const [key, record] of this.records) {
      if (record.status !== 'failed') continue;
      if ((record.attempts || 0) < maxAttempts) continue;
      reset.push({ key, attempts: record.attempts, lastError: record.lastError });
      record.attempts = 0;
      delete record.nextAttemptAt;
      record.updatedAt = new Date().toISOString();
    }
    if (reset.length) this._save();
    return reset;
  }

  remove(key) {
    if (!this.records.delete(key)) return;
    this._save();
  }
}

module.exports = { StateStore };
