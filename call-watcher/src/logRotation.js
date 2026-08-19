const fs = require('fs');

const TIMESTAMP_PATTERN = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]/;

// Keeps call-watcher.log from growing forever by dropping any line older than maxAgeMs, based
// on the ISO timestamp each line already starts with (written by makeLogger in index.js) -
// not tied to any specific call's scheduled time, since a single log file interleaves many
// different calls' lines together and correlating each line back to "its" call would be far
// more complex for little benefit. A simple rolling window keeps the file naturally bounded.
// Uses sync fs calls deliberately: the logger itself writes synchronously, so this avoids any
// race between a concurrent append and this read-modify-write pass.
function pruneOldLogLines(logPath, maxAgeMs) {
  let content;
  try {
    content = fs.readFileSync(logPath, 'utf8');
  } catch {
    return; // no log file yet - nothing to prune
  }

  const cutoff = Date.now() - maxAgeMs;
  const lines = content.split('\n');
  const kept = lines.filter((line) => {
    const match = TIMESTAMP_PATTERN.exec(line);
    if (!match) return true; // not a line we recognize the shape of - keep it rather than guess
    const lineTime = Date.parse(match[1]);
    return Number.isNaN(lineTime) || lineTime >= cutoff;
  });

  if (kept.length !== lines.length) {
    fs.writeFileSync(logPath, kept.join('\n'));
  }
}

module.exports = { pruneOldLogLines };
