const fs = require('fs');
const path = require('path');

// Two durable artifacts, both written next to the logs:
//
//   heartbeat.json          - overwritten every poll. Answers "is it alive and seeing data?"
//   outcomes-YYYY-MM-DD.jsonl - append-only, one line per call attempt. Never pruned.
//
// These exist because the failure that matters most here is silent: a missed earnings call
// leaves no trace, and the call does not happen twice. Before this, "did we capture X today?"
// and "did it stop at 09:40?" were both unanswerable after the fact - the log was the only
// record, and nothing recorded which calls were due versus actually started.
//
// JSONL rather than JSON for outcomes: appending a line is atomic enough for this purpose and
// cannot corrupt earlier records, whereas rewriting a growing JSON array can lose the whole
// day's history if the process dies mid-write.

function dayStamp(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function createObservability(dataDir, logger) {
  fs.mkdirSync(dataDir, { recursive: true });
  const heartbeatPath = path.join(dataDir, 'heartbeat.json');
  const startedAt = new Date().toISOString();
  const counters = { pollCount: 0, attempted: 0, started: 0, failed: 0, skippedLate: 0 };

  // Deliberately best-effort: observability must never be the thing that kills the run. A
  // transient file lock (antivirus, backup agent) on a work laptop would otherwise take down
  // the process from inside a setInterval.
  const safeWrite = (fn, what) => {
    try {
      fn();
    } catch (err) {
      logger.warn(`Could not write ${what}: ${err.message}`);
    }
  };

  return {
    counters,

    // Called every poll. `health` carries what an external watchdog needs to judge liveness
    // without parsing logs: staleness of this file, plus whether the table is still readable.
    heartbeat({ rowsSeen, withLinks, parseableTimes = null, dueNow, queueDepth, openCallTabs, streamReadFailures = 0, chromeConnected }) {
      counters.pollCount++;
      safeWrite(() => {
        fs.writeFileSync(
          heartbeatPath,
          JSON.stringify(
            {
              updatedAt: new Date().toISOString(),
              pid: process.pid,
              startedAt,
              pollCount: counters.pollCount,
              rowsSeen,
              withLinks,
              parseableTimes,
              dueNow,
              queueDepth,
              openCallTabs,
              streamReadFailures,
              chromeConnected,
              // A watchdog should alert on any of these being true, not just on staleness:
              // they are the "running but blind" states that used to look like a quiet day.
              warnings: {
                noRows: rowsSeen === 0,
                noLinks: rowsSeen > 0 && withLinks === 0,
                // Rows and links present, but no readable Transcription Time: nothing can
                // ever become due, and every other signal here looks perfectly healthy.
                noReadableTimes: withLinks > 0 && parseableTimes === 0,
                queueBacklog: queueDepth > 3,
                // Tabs are closed when their call completes; a climbing count means completion
                // is not being observed, which is how Chrome ends up out of memory over days.
                tabLeak: openCallTabs > 12,
                // A persistent failure to read the extension's stream list wedges every row
                // that already has a record, while first attempts keep working - so nothing
                // in the log looks wrong.
                cannotReadStreams: streamReadFailures >= 3,
                chromeDisconnected: chromeConnected === false,
              },
              totals: { ...counters },
            },
            null,
            2
          ) + '\n'
        );
      }, 'heartbeat.json');
    },

    // One line per attempt outcome. Records the URL actually opened and the page title actually
    // recorded, which is what makes "was this the right page?" answerable later - the specific
    // question that could not be answered when six captures ran against a "Page Not Found".
    recordOutcome(entry) {
      if (entry.status === 'started') counters.started++;
      else if (entry.status === 'failed') counters.failed++;
      else if (entry.status === 'skipped-late') counters.skippedLate++;
      if (entry.status !== 'skipped-late') counters.attempted++;

      safeWrite(() => {
        fs.appendFileSync(
          path.join(dataDir, `outcomes-${dayStamp()}.jsonl`),
          JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'
        );
      }, 'outcomes ledger');
    },

    // Printed on demand and at shutdown so the operator gets a checkable artifact instead of
    // an impression. Reads the day's ledger back rather than trusting in-memory counters, so it
    // still works after a restart.
    summarize(now = new Date()) {
      const file = path.join(dataDir, `outcomes-${dayStamp(now)}.jsonl`);
      let lines = [];
      try {
        lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      } catch {
        // No ledger for today yet - the normal state on a quiet day, or before the first
        // call of one. This deliberately falls THROUGH to the single return below instead
        // of returning its own object literal: the hand-written early return that used to
        // be here omitted `retriedThenStarted`, so the shutdown handler's
        // `summary.retriedThenStarted.length` threw and every clean Ctrl+C on a day with
        // no recorded calls lost the summary it exists to print.
        lines = [];
      }
      const started = [];
      const failed = [];
      const skippedLate = [];
      for (const line of lines) {
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        const label = `${e.symbol} ${e.fiscalPeriod}`;
        // The timestamp is carried through so the shutdown summary can show WHEN each outcome
        // happened. Without it a short run prints the whole day's failures with no indication
        // they predate it - which reads as though this run just failed that many times.
        const at = (e.ts || '').slice(11, 19);
        if (e.status === 'started') started.push({ label, at, lateBySec: e.secondsLateVsScheduled, title: e.pageTitle });
        else if (e.status === 'failed') failed.push({ label, at, error: e.error });
        else if (e.status === 'skipped-late') skippedLate.push({ label, at, minsPastStart: e.minsPastStart });
      }
      // A symbol can appear as failed then started (a retry that worked) - report the final
      // state per call so the summary is not double-counting the same call.
      const startedLabels = new Set(started.map((s) => s.label));
      return {
        date: dayStamp(now),
        total: lines.length,
        started,
        failed: failed.filter((f) => !startedLabels.has(f.label)),
        retriedThenStarted: failed.filter((f) => startedLabels.has(f.label)).map((f) => f.label),
        skippedLate,
      };
    },
  };
}

module.exports = { createObservability };
