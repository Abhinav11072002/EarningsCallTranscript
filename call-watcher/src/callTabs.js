// Owns the tabs that hold live captures, and decides when each one may be closed.
//
// The governing fact: THE TAB IS THE RECORDING. The extension captures that tab's audio, so
// closing it stops the capture immediately. Nothing here may close a tab that is still
// recording, whatever its age - which is why every rule below is expressed in terms of whether
// the extension still has a stream for it, and only then in terms of time.
//
// Why closing them promptly matters at all: each recording tab keeps the whole call's audio
// chunks in page memory, tens of megabytes for an hour, and holds them until the tab closes.
// Ten stale tabs is real memory, and the tabs pile up exactly when the day is busiest.

const DEFAULT_CONFIRMATIONS = 2;

class CallTabRegistry {
  constructor(logger) {
    this.logger = logger;
    this.tabs = new Map(); // key -> { page, openedAt, dueAt, label, notRecordingPolls }
  }

  // dueAt is the call's scheduled start, in epoch ms, or null when the portal gave no time.
  // Knowing when the CALL was is much sharper than knowing how long the tab has existed: a tab
  // opened fifteen minutes early for a call that has since ended is finished, and one opened at
  // the same moment for a call that has not started yet is not.
  // `row` is kept so the sweep can ask the extension whether THIS call is still recording;
  // streamMatchesRow needs the symbol and period, and the registry is the only place that still
  // knows which row a tab belongs to once the poll that opened it has finished.
  register(key, page, label, dueAt = null, row = null) {
    const existing = this.tabs.get(key);
    if (existing && existing.page !== page) this._close(key, existing, 'superseded by a new attempt');
    this.tabs.set(key, { page, openedAt: Date.now(), dueAt, label, row, notRecordingPolls: 0 });
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
        // A tab the user closed by hand, or one that went with a crashed renderer. Already gone
        // is the outcome we wanted.
      });
  }

  closeFor(key, reason) {
    const entry = this.tabs.get(key);
    if (entry) this._close(key, entry, reason);
  }

  // Is any tab far enough along that a closing decision is actually pending?
  //
    // Used to decide whether this poll needs the extension's stream list at all. Reading it opens
  // an extension tab, so asking on every poll for tabs that are obviously still live would be
  // churn for nothing.
  hasPendingDecisions(endedGraceMs, softMaxAgeMs) {
    const now = Date.now();
    for (const entry of this.tabs.values()) {
      if (entry.dueAt !== null && now > entry.dueAt + endedGraceMs) return true;
      if (now - entry.openedAt > softMaxAgeMs) return true;
    }
    return false;
  }

  // Called every poll.
  //
  //   isFinished(key)          the record says this call reached a terminal state
  //   isRecording(key, entry)  true / false / null, where NULL means it could not be checked
  //
  // The three-way answer is the whole safety story. "We could not check" must never be treated
  // as "it is not recording", or one unreadable stream list kills every live capture at once.
  sweep({ isFinished, isRecording, softMaxAgeMs, hardMaxAgeMs, endedGraceMs, confirmations = DEFAULT_CONFIRMATIONS }) {
    const now = Date.now();

    for (const [key, entry] of [...this.tabs]) {
      if (entry.page.isClosed()) {
        this.tabs.delete(key);
        continue;
      }

      if (isFinished(key)) {
        this._close(key, entry, 'call finished');
        continue;
      }

      const recording = isRecording(key, entry);

      if (recording === true) {
        // Still capturing. Never closed here, at any age - the age caps exist to catch tabs
        // whose ending was never observed, not to interrupt a long call. A stream cannot linger
        // indefinitely anyway: the extension stops one after ten minutes of silence.
        entry.notRecordingPolls = 0;
        continue;
      }

      if (recording === null) {
        // Blind this poll. Fall back to the old behaviour: a generous absolute cap, so a machine
        // that can NEVER read the stream list still does not accumulate tabs forever.
        entry.notRecordingPolls = 0;
        if (now - entry.openedAt > hardMaxAgeMs) {
          this._close(
            key,
            entry,
            `exceeded the ${Math.round(hardMaxAgeMs / 60000)} min cap, and whether it was still recording could not be checked`
          );
        }
        continue;
      }

      // Not recording. Confirmed over consecutive polls, because a single failed or racing read
      // would otherwise close a tab that is mid-capture - and that does not mislabel a
      // recording, it destroys one.
      entry.notRecordingPolls += 1;
      if (entry.notRecordingPolls < confirmations) continue;

      if (entry.dueAt !== null && now > entry.dueAt + endedGraceMs) {
        const pastMin = Math.round((now - entry.dueAt) / 60000);
        this._close(key, entry, `nothing is recording it and the call started ${pastMin} min ago`);
        continue;
      }

      if (now - entry.openedAt > softMaxAgeMs) {
        this._close(
          key,
          entry,
          `nothing is recording it and the tab is older than ${Math.round(softMaxAgeMs / 60000)} min`
        );
      }
    }
  }
}

module.exports = { CallTabRegistry };
