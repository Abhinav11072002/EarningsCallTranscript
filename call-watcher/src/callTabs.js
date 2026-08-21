// Tracks the tab opened for each call so it can be closed once the call is done.
//
// The pipeline deliberately does NOT close a tab on success: the capture lives in that tab, so
// closing it would kill the recording. But nothing closed them afterwards either, which is
// fine for an afternoon and fatal for a process meant to run indefinitely - every call leaves a
// tab holding a MediaRecorder and a websocket. Chrome was observed at 84 processes / ~11 GB
// after heavy testing; a busy day is 130+ calls.
//
// Two independent triggers, because either alone leaves a gap:
//   - the call is finished (its stream is gone from the extension) -> close it promptly
//   - a hard maximum age -> catches anything whose completion we never observed, e.g. because
//     the extension was reloaded or its storage was cleared
class CallTabRegistry {
  constructor(logger) {
    this.logger = logger;
    this.tabs = new Map(); // key -> { page, openedAt, label }
  }

  register(key, page, label) {
    // If a previous tab is somehow still registered for this key, close it rather than leak it.
    const existing = this.tabs.get(key);
    if (existing && existing.page !== page) this._close(key, existing, 'superseded by a new attempt');
    this.tabs.set(key, { page, openedAt: Date.now(), label });
  }

  size() {
    return this.tabs.size;
  }

  _close(key, entry, reason) {
    this.tabs.delete(key);
    const ageMin = ((Date.now() - entry.openedAt) / 60000).toFixed(0);
    entry.page
      .close()
      .then(() => this.logger.info(`Closed tab for ${entry.label} after ${ageMin} min (${reason}).`))
      .catch(() => {
        // Already gone (user closed it, or Chrome discarded it) - nothing to do.
      });
  }

  closeFor(key, reason) {
    const entry = this.tabs.get(key);
    if (entry) this._close(key, entry, reason);
  }

  // Called every poll. `isFinished(key)` decides completion; the age cap is the backstop.
  sweep(isFinished, maxAgeMs) {
    for (const [key, entry] of [...this.tabs]) {
      if (entry.page.isClosed()) {
        this.tabs.delete(key);
        continue;
      }
      if (isFinished(key)) {
        this._close(key, entry, 'call finished');
      } else if (Date.now() - entry.openedAt > maxAgeMs) {
        this._close(key, entry, `exceeded the ${Math.round(maxAgeMs / 60000)} min tab age cap`);
      }
    }
  }
}

module.exports = { CallTabRegistry };
