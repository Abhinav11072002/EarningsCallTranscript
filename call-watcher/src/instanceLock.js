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
// The lock is advisory: a file holding the pid, and a timestamp the holder keeps refreshing.
// A lock is only honoured while its holder keeps proving it is alive. Liveness by pid ALONE is
// not enough on Windows, where pids are recycled aggressively: a watcher that is hard-killed
// leaves its lock behind, and once the OS hands that number to any unrelated process the lock
// looks permanently held and no watcher can start again without deleting a file by hand. That
// turns the safeguard into an outage, which is the one thing it must never be.
//
// So the holder refreshes the lock every poll, and a lock not refreshed within this window is
// treated as abandoned whatever its pid says. Generous relative to the poll interval, because
// taking a lock away from a live watcher is far worse than waiting an extra minute.
// Six polls at the default 20s interval. Short enough that a hard-killed watcher's lock is
// never in the way for long, generous enough that a watcher busy preparing a batch of calls is
// never mistaken for a dead one.
const DEFAULT_STALE_LOCK_MS = 60000;

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
function acquireInstanceLock(dataDir, { pid = process.pid, now = new Date(), staleAfterMs = DEFAULT_STALE_LOCK_MS } = {}) {
  const file = lockPathFor(dataDir);
  let holder = null;
  try {
    holder = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    holder = null; // no lock, or an unreadable one we are entitled to replace
  }

  let staleReason = null;
  if (holder && holder.pid !== pid) {
    // refreshedAt is absent on a lock written by an older build, so fall back to startedAt -
    // otherwise upgrading would leave behind a lock that could never go stale.
    const beat = Date.parse(holder.refreshedAt || holder.startedAt || '');
    const age = Number.isFinite(beat) ? now.getTime() - beat : Infinity;
    if (age > staleAfterMs) {
      staleReason = Number.isFinite(age)
        ? `its lock has not been refreshed for ${Math.round(age / 1000)}s`
        : 'its lock carries no usable timestamp';
    } else if (pidIsRunning(holder.pid)) {
      return { ok: false, holder };
    } else {
      staleReason = 'that process is no longer running';
    }
  }

  const takeover = holder && holder.pid !== pid
    ? { pid: holder.pid, startedAt: holder.startedAt, reason: staleReason }
    : null;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ pid, startedAt: now.toISOString(), refreshedAt: now.toISOString() }, null, 2) + '\n'
    );
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

// Called every poll by the holder. Cheap, and it is what lets a lock left by a hard kill
// expire on its own rather than waiting for a human.
function refreshInstanceLock(dataDir, { pid = process.pid, now = new Date() } = {}) {
  const file = lockPathFor(dataDir);
  try {
    const holder = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (holder.pid !== pid) return false; // someone else owns it now - never stamp their file
    holder.refreshedAt = now.toISOString();
    fs.writeFileSync(file, JSON.stringify(holder, null, 2) + '\n');
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  acquireInstanceLock,
  releaseInstanceLock,
  refreshInstanceLock,
  lockPathFor,
  pidIsRunning,
  DEFAULT_STALE_LOCK_MS,
};
