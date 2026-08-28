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
  //
  // Neither is a call that has already REACHED A TERMINAL STATE. A completed record means the
  // poll loop has finished with this call, one way or the other, and whatever happened was
  // recorded when it happened. Saying "missed" about it afterwards is not a second opinion, it
  // is a second, wrong entry.
  //
  // FRO 2026Q2 is what this looked like. It joined fifteen minutes early, audio audible,
  // written to the ledger as started - a complete and correct capture, with the transcript to
  // show for it. When the call ended its stream vanished, the loop marked it completed, and
  // every poll after that fell through to here and reported "Missed FRO 2026Q2: attempted 1x
  // without success". Twice in the ledger, once per process, on a call that worked.
  //
  // Pass 2 of the poll loop has always treated completed as terminal. This is the same rule,
  // applied one pass earlier.
  if (record && (record.status === 'started' || record.status === 'completed')) return null;
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

// Whether a capture that has stopped should be restarted NOW.
//
// The flow is deliberately: join early, set the recording going, move on to the next call. A
// capture already running cannot miss the opening remarks, which is the whole point of starting
// before the call does.
//
// What that flow runs into is the extension stopping a stream after about ten minutes of
// silence. Join at T-15, and by T-5 - with nobody yet speaking - the stream is gone. The poll
// loop saw a started call with no stream, concluded it had died, and reacquired: a new tab, the
// old one closed, another attempt spent. Then the same thing again five minutes later. By the
// time the call actually began, all four attempts were used and the call was marked as given up.
//
// So before the call starts, a missing stream is not evidence of anything going wrong. Nothing
// is being lost by waiting - there is no audio yet to miss - and restarting into the same
// silence only repeats the problem while burning the attempts that will be needed later.
//
// Once the call is under way, a missing stream means exactly what it used to, and reacquiring
// promptly is right.
function shouldReacquireNow({ minsLeft, reacquireGraceMinutes = 30, startsWithinMinutes = 1 }) {
  // Long past the start: the call is simply over. The caller treats this as terminal.
  if (minsLeft <= -reacquireGraceMinutes) return { reacquire: false, reason: 'call is over' };

  // Not started yet. Wait for it rather than restarting into silence.
  if (minsLeft > startsWithinMinutes) {
    return {
      reacquire: false,
      waiting: true,
      reason:
        `the call has not started yet (${minsLeft.toFixed(0)} min away), so a stopped stream is ` +
        'the extension timing out on silence rather than anything going wrong',
    };
  }

  return { reacquire: true, reason: 'the call is under way and nothing is recording it' };
}

module.exports = { shouldSkipAsLate, shouldReacquireNow };
