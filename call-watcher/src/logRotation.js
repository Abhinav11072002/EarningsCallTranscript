const fs = require('fs');
const path = require('path');

const LOG_BASENAME = 'call-watcher';
const DEFAULT_RETENTION_DAYS = 14;
const ROTATED_LOG_PATTERN = /^call-watcher-(\d{4}-\d{2}-\d{2})\.log$/;

// Logs are written to one file per local day (call-watcher-YYYY-MM-DD.log), so the file
// "rotates" simply by the name changing at midnight - no renaming, no truncation, and no
// window where a write could race a rotation.
//
// This replaces an earlier approach that pruned individual log LINES older than an hour. That
// was doubly wrong. It deleted exactly the evidence needed to diagnose a failure noticed a few
// hours later; and it barely worked anyway, because entries containing embedded newlines (the
// PowerShell output from the shortcut injector) produce continuation lines with no timestamp,
// which the pruner could not attribute to a time and therefore kept forever. Measured on a
// real log: 4 of 293 lines were prunable and 289 stale lines survived indefinitely.
function resolveLogPath(dir, now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return path.join(dir, `${LOG_BASENAME}-${y}-${m}-${d}.log`);
}

// Deletes whole day-files past the retention horizon. Bounded disk use, and every retained day
// is complete - which is the property that makes a post-mortem possible at all.
function pruneOldLogFiles(dir, retentionDays = DEFAULT_RETENTION_DAYS, now = new Date()) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return []; // log directory does not exist yet
  }

  const cutoff = new Date(now);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - retentionDays);

  const removed = [];
  for (const name of entries) {
    const match = ROTATED_LOG_PATTERN.exec(name);
    if (!match) continue;
    // Parsed as local midnight so the comparison matches how the file was named.
    const [year, month, day] = match[1].split('-').map(Number);
    const fileDate = new Date(year, month - 1, day);
    if (Number.isNaN(fileDate.getTime()) || fileDate >= cutoff) continue;
    try {
      fs.unlinkSync(path.join(dir, name));
      removed.push(name);
    } catch {
      // A file held open by another process is not worth failing the run over.
    }
  }
  return removed;
}

module.exports = { resolveLogPath, pruneOldLogFiles, LOG_BASENAME };
