const fs = require('fs');
const path = require('path');

class StateStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.records = new Map();
    this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        for (const key of data) this.records.set(key, { status: 'started', attempts: 1 });
      } else {
        this.records = new Map(Object.entries(data));
      }
    } catch {
      this.records = new Map();
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(Object.fromEntries(this.records), null, 2));
    fs.renameSync(tempPath, this.filePath);
  }

  get(key) {
    return this.records.get(key) || null;
  }

  claim(key) {
    const previous = this.records.get(key);
    const record = {
      status: 'claimed',
      attempts: (previous?.attempts || 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    this.records.set(key, record);
    this._save();
    return record;
  }

  markStarted(key) {
    const record = this.records.get(key);
    if (!record) return;
    this.records.set(key, { ...record, status: 'started', updatedAt: new Date().toISOString() });
    this._save();
  }

  fail(key, error, retryDelayMs) {
    const record = this.records.get(key) || { attempts: 1 };
    this.records.set(key, {
      ...record,
      status: 'failed',
      lastError: error,
      nextAttemptAt: new Date(Date.now() + retryDelayMs).toISOString(),
      updatedAt: new Date().toISOString(),
    });
    this._save();
  }

  retryDue(key, claimTimeoutMs = 30 * 60 * 1000) {
    const record = this.records.get(key);
    if (!record) return true;
    if (record.status === 'claimed') {
      return !record.updatedAt || Date.parse(record.updatedAt) + claimTimeoutMs <= Date.now();
    }
    if (record.status !== 'failed') return false;
    return !record.nextAttemptAt || Date.parse(record.nextAttemptAt) <= Date.now();
  }

  remove(key) {
    if (!this.records.delete(key)) return;
    this._save();
  }
}

module.exports = { StateStore };
