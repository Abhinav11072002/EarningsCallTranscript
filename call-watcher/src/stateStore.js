const fs = require('fs');
const path = require('path');

class StateStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.processed = new Set();
    this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const arr = JSON.parse(raw);
      this.processed = new Set(arr);
    } catch {
      this.processed = new Set();
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify([...this.processed], null, 2));
  }

  has(key) {
    return this.processed.has(key);
  }

  add(key) {
    this.processed.add(key);
    this._save();
  }
}

module.exports = { StateStore };
