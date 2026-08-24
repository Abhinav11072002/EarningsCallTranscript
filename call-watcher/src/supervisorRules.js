// When the supervisor should conclude that a running watcher is no longer doing its job.
//
// Separated from scripts/supervisor.js so it can be tested without spawning anything - the
// script starts a child process the moment it is required, which is exactly the kind of thing
// a test must never trigger.
//
// The bar is deliberately high. Restarting a healthy watcher mid-capture destroys a recording
// that was going fine, so this only fires on states where the watcher demonstrably cannot do
// its job any more: it has stopped polling, or it is polling into a void.

// Reasons, in the order they are checked. Staleness first because it subsumes the rest: a
// heartbeat that is not being written at all makes its warning flags meaningless.
function blindReason(heartbeat, { pid = null, now = Date.now(), staleAfterMs = 300000 } = {}) {
  // No heartbeat yet is not a fault - a freshly started watcher has not written one. The caller
  // covers that window with a start grace instead, because killing a process for not having
  // finished starting is a loop that never terminates.
  if (!heartbeat) return null;

  // A heartbeat left behind by a PREVIOUS run says nothing about the current child, and acting
  // on it would restart a healthy process for its predecessor's sins.
  if (pid && heartbeat.pid && heartbeat.pid !== pid) return null;

  const stamp = Date.parse(heartbeat.updatedAt || '');
  if (Number.isFinite(stamp)) {
    const age = now - stamp;
    if (age > staleAfterMs) {
      return `heartbeat is ${Math.round(age / 1000)}s old (limit ${Math.round(staleAfterMs / 1000)}s) - the poll loop has stopped making progress`;
    }
  }

  const w = heartbeat.warnings || {};
  // Each of these means the watcher is alive and seeing nothing it can act on. All of them look
  // identical to a quiet day in the log, which is the entire reason they are surfaced here.
  if (w.chromeDisconnected) return 'Chrome is disconnected';
  if (w.noRows) return 'the table is producing zero rows - the portal session has probably expired';
  if (w.noLinks) return 'the table has rows but zero dial-in links';
  if (w.noReadableTimes) return 'no Transcription Time on any row could be read';
  if (w.cannotReadStreams) return 'the extension stream list has been unreadable for several polls';

  return null;
}

module.exports = { blindReason };
