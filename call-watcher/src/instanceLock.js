const fs = require('fs');
const path = require('path');

// Stops a second watcher from running against the same Chrome and the same data directory.
//
// Not hypothetical - it happened during this project's own testing, and it took a while to
// notice: two watchers were polling at once, both writing heartbeat.json, so the heartbeat
// described whichever process wrote last. The symptom was a heartbeat whose startedAt and
// pollCount belonged to a process nobody thought was still running.
//
// Why it matters beyond confusing telemetry. The two share every piece of state and none of it
// is designed for it:
//
//   - processed.json is loaded into memory once per process and rewritten whole. Two writers
//     means last-write-wins, so one can erase the other's claim and the same call gets
//     dispatched twice - two tabs, two triggers, and the second capture killing the first.
//   - the extension popup is a single global resource. Two triggers overlapping is the exact
//     condition the batch pipeline goes to some length to prevent WITHIN a process.
//   - the seen log and outcomes ledger would interleave two views of the day.
//
// The lock is advisory and deliberately simple: a file holding the pid. A stale lock left by a
// crash is detected by asking the OS whether that pid still exists, so a hard kill never
// requires manual cleanup - which would make the lock itself a source of downtime.
function lockPathFor(dataDir) {
  return path.join(dataDir, 'watcher.lock');
}

// signal 0 performs the permission/existence check without delivering anything. ESRCH means no
// such process; EPERM means it exists but belongs to someone else - which still counts as
// running, so we must not steal the lock.
function pidIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Returns { ok: true, takeover } or { ok: false, holder }. Never throws for the expected cases:
// refusing to start is a decision for the caller to report, not an exception to leak.
function acquireInstanceLock(dataDir, { pid = process.pid, now = new Date() } = {}) {
  const file = lockPathFor(dataDir);
  let holder = null;
  try {
    holder = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    holder = null; // no lock, or an unreadable one we are entitled to replace
  }

  if (holder && holder.pid !== pid && pidIsRunning(holder.pid)) {
    return { ok: false, holder };
  }

  const takeover = holder ? { pid: holder.pid, startedAt: holder.startedAt } : null;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid, startedAt: now.toISOString() }, null, 2) + '\n');
  } catch (err) {
    // A directory we cannot write is a real problem, but not one worth refusing to run over -
    // the lock is a safeguard, not the job.
    return { ok: true, takeover, warning: `could not write the instance lock: ${err.message}` };
  }
  return { ok: true, takeover };
}

// Only removes the lock if we still hold it, so a takeover by a legitimate successor is never
// undone by the previous holder's exit handler firing late.
function releaseInstanceLock(dataDir, { pid = process.pid } = {}) {
  const file = lockPathFor(dataDir);
  try {
    const holder = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (holder.pid !== pid) return false;
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

module.exports = { acquireInstanceLock, releaseInstanceLock, lockPathFor, pidIsRunning };
