// When a call may still be attempted.
//
// The rule: an attempt may only START before the call's scheduled time. Once the call has
// begun, a call we never got into is gone - we do not go back to it.
//
// Why, concretely. A late join is not a partial success, it is a failure that looks like a
// success: it confirms "started", writes a Done line and files a transcript missing the
// opening remarks and guidance - the part of an earnings call that matters most. Nothing
// downstream can tell that transcript from a complete one. And on the way there it spends the
// pipeline lock, which is single-threaded, so a doomed retry of a call that has already begun
// directly delays calls that have not.
//
// The exception is a call already being CAPTURED whose stream drops mid-way. Reacquiring that
// is not going back to a missed call, it is keeping a capture alive that is already running,
// and it is governed separately by reacquireGraceMinutes. That distinction is the whole reason
// this takes the record rather than just the clock.

// Deliberately not "roughly zero". minsLeft is derived from the portal's own countdown, so at
// minsLeft <= 0 the call is under way by the portal's own reckoning, and that is the line.
// A tolerance can be set with lateStartGraceMinutes for anyone who wants one, but it defaults
// to 0 - see config.json.
function shouldSkipAsLate({ minsLeft, record, lateStartGraceMinutes = 0 }) {
  // A capture already in progress is never "late" - its stream may need reacquiring, which the
  // caller decides using reacquireGraceMinutes.
  if (record && record.status === 'started') return null;
  if (minsLeft > -lateStartGraceMinutes) return null;

  const attempts = record ? record.attempts || 0 : 0;
  return {
    minsPastStart: Number(Math.abs(minsLeft).toFixed(1)),
    attempts,
    // The two cases read very differently in a log and want different follow-up: one is a call
    // the watcher never saw in time, the other is one it saw and could not get into.
    reason: attempts === 0 ? 'never attempted' : `attempted ${attempts}x without success`,
  };
}

module.exports = { shouldSkipAsLate };
