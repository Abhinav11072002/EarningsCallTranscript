// Stops the running watcher, using the lock file as the source of truth.
//
// This exists because finding the process by hand is genuinely error-prone, and got it wrong
// twice during this project's own development. The command line depends on how it was
// launched: `npm start` produces "node  src/index.js", while running it directly produces
// `"C:\Program Files\nodejs\node.exe" src/index.js`. A filter written for one silently matches
// nothing for the other and cheerfully reports success - after which the watcher is still
// running, still holding the lock, and every later start is refused for reasons that look
// inexplicable.
//
// Worse, a loose filter is dangerous in the other direction: `*src/index.js*` also matches
// unrelated Node tools (an MCP server on this very machine ends in dist/src/index.js), so a
// careless cleanup can kill something that has nothing to do with this project.
//
// The lock file avoids both failures: the watcher writes its own pid there, whatever it was
// launched as, and nothing else does.
//
// Usage: npm run stop
const fs = require('fs');
const path = require('path');
const { lockPathFor, pidIsRunning } = require('../src/instanceLock');

const DATA_DIR = path.join(__dirname, '..', 'data');
const lockFile = lockPathFor(DATA_DIR);

let holder = null;
try {
  holder = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
} catch {
  console.log('No lock file - no watcher appears to be running.');
  process.exit(0);
}

if (!holder || !Number.isInteger(holder.pid)) {
  console.log('The lock file is unreadable; removing it. Nothing to stop.');
  try {
    fs.unlinkSync(lockFile);
  } catch {}
  process.exit(0);
}

if (!pidIsRunning(holder.pid)) {
  console.log(`The lock names pid ${holder.pid}, which is no longer running. Removing the stale lock.`);
  try {
    fs.unlinkSync(lockFile);
  } catch {}
  process.exit(0);
}

console.log(`Stopping the watcher (pid ${holder.pid}, started ${holder.startedAt})...`);
try {
  process.kill(holder.pid);
} catch (err) {
  console.error(`Could not stop pid ${holder.pid}: ${err.message}`);
  console.error('If it belongs to another user or an elevated session, stop it from Task Manager.');
  process.exit(1);
}

// Give the OS a moment, then confirm rather than assume - "cheerfully reported success while
// the process was still running" is the exact failure this script exists to prevent.
setTimeout(() => {
  if (pidIsRunning(holder.pid)) {
    console.error(`Pid ${holder.pid} is still running. Stop it from Task Manager, then run this again.`);
    process.exit(1);
  }
  try {
    const current = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    // Only remove the lock if it is still the one we just acted on - a new watcher may have
    // legitimately started and taken it over in the meantime.
    if (current.pid === holder.pid) fs.unlinkSync(lockFile);
  } catch {}
  console.log('Stopped.');
  // On Windows a process killed this way does not run its Node signal handlers, so it never
  // prints its own shutdown summary. `npm run report` gives the same information, and more.
  console.log('For the day\'s outcome, run: npm run report');
}, 1500);
