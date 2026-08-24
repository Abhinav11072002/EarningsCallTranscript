// Small concurrency primitives for running a batch of calls through the pipeline.
//
// The pipeline used to be one strictly serial queue: every call did resolve -> join -> form ->
// trigger, start to finish, before the next one began. That was correct but it made the
// window's capacity depend on the SLOWEST calls, which matters now that an attempt has to
// finish before the call starts (see dispatchRules.js) - a call that runs long no longer just
// delays the next one, it can push it past its start time and lose it outright.
//
// Only one part of the pipeline actually requires exclusivity: triggering the extension. That
// step brings a tab to the foreground and drives a popup that closes the instant its tab loses
// focus, so a tab opening anywhere else mid-trigger can capture the wrong tab or kill the
// popup - both verified in this project. Everything BEFORE it (opening the page, resolving the
// webcast link, walking join screens, filling a form) touches only its own tab and can run
// alongside other calls.

// Runs fn over items with at most `limit` in flight, preserving input order in the results.
// Never rejects: a thrown fn becomes { ok: false, error } so one bad call cannot abort a batch
// and take the other calls in the window down with it.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  const width = Math.max(1, Math.min(Number(limit) || 1, items.length));
  let next = 0;

  async function worker() {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = { ok: true, value: await fn(items[index], index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  }

  await Promise.all(Array.from({ length: width }, worker));
  return results;
}

// A promise-chain mutex. Used for the few operations that share one piece of state and would
// corrupt each other if interleaved - notably clicking a truncated link on the portal tab,
// which clicks a cell and waits for the tab it opens. Two of those at once on the same page
// cannot tell which tab belongs to which click, and would hand a call the wrong URL.
class Mutex {
  constructor() {
    this._tail = Promise.resolve();
  }

  run(fn) {
    const result = this._tail.then(fn, fn);
    // Swallow rejections on the CHAIN only: the caller still receives the real rejection, but
    // one failure must not poison every later acquisition of the lock.
    this._tail = result.then(
      () => {},
      () => {}
    );
    return result;
  }
}

// Rejects if fn has not settled within ms. The timer is always cleared - an un-cleared timer
// keeps the event loop alive and would stop the process exiting on Ctrl+C.
function withDeadline(promise, ms, message) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// The batch shape itself: prepare several at once, then act on them strictly one at a time.
//
// This lives here, separated from the Playwright wiring in index.js, so the ORDERING RULES can
// be tested directly with stubs. They are the part that has to be right and the part that is
// hardest to observe in production: that no two triggers ever overlap (a trigger drives a popup
// that dies when its tab loses focus), that a preparation failing costs only its own call, and
// that results stay paired with the right row.
//
// `trigger` is awaited one at a time, in the original item order, so the most urgent call -
// items are handed in sorted by time remaining - is triggered first.
async function runPreparedBatch(items, { width, prepare, trigger, onPrepareFailure }) {
  const prepared = await mapWithConcurrency(items, width, (item, index) => prepare(item, index));

  for (let index = 0; index < items.length; index++) {
    const slot = prepared[index];
    if (!slot || !slot.ok) {
      const error = slot ? slot.error : new Error('preparation produced no result');
      if (onPrepareFailure) await onPrepareFailure(items[index], error, index);
      continue;
    }
    await trigger(slot.value, items[index], index);
  }
}

module.exports = { mapWithConcurrency, Mutex, withDeadline, runPreparedBatch };
