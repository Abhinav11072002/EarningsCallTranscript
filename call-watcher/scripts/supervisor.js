// Keeps the watcher running, and notices when it is running but blind.
//
// Two independent failure modes, and neither had anything watching for it:
//
//   1. The process DIES - an uncaught error, Chrome going away in a way recovery cannot handle,
//      a Windows update closing the terminal. Until now the only symptom was a closed window
//      and, hours later, missing transcripts.
//   2. The process LIVES but stops making progress - a wedged renderer, an expired portal
//      session, a Chrome that disconnected. The log keeps ticking and everything looks normal.
//      heartbeat.json was built to expose exactly this, and nothing read it.
//
// So this supervises on both axes: restart on exit, and restart when the heartbeat goes stale
// or reports a blind state. Restarts are rate-limited, because a process that cannot start at
// all should stop and say so rather than spin forever writing log files.
//
// Usage: npm run supervise      (in place of npm start)
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../src/loadConfig');
const { resolveLogPath } = require('../src/logRotation');
const { blindReason } = require('../src/supervisorRules');
const { releaseInstanceLock } = require('../src/instanceLock');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const HEARTBEAT = path.join(DATA_DIR, 'heartbeat.json');

const config = loadConfig();
const pollIntervalMs = Number(config.pollIntervalMs ?? 20000);

// Generous on purpose: a poll can legitimately take a while when a batch is preparing several
// calls, and killing a healthy run mid-capture is far worse than reacting a minute late.
const STALE_AFTER_MS = Math.max(5 * 60000, pollIntervalMs * 10);
const CHECK_INTERVAL_MS = 30000;
// Give a fresh child time to connect to Chrome and write its first heartbeat before judging it.
const GRACE_AFTER_START_MS = 90000;
const RESTART_DELAY_MS = 5000;
// A crash loop is a real failure, not something to paper over. If the child cannot stay up this
// many times inside the window, stop and leave the reason on disk.
// Matches EXIT_REFUSED_TO_START in src/index.js.
const EXIT_REFUSED_TO_START = 78;
const MAX_RESTARTS_IN_WINDOW = 5;
const RESTART_WINDOW_MS = 10 * 60000;

function log(level, message) {
  const line = `[${new Date().toISOString()}] [SUPERVISOR/${level}] ${message}`;
  console.log(line);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(resolveLogPath(DATA_DIR), line + '\n');
  } catch {
    // Same rule as the watcher's own logger: bookkeeping never kills the run.
  }
}

let child = null;
let childStartedAt = 0;
let stopping = false;
const restartTimes = [];

function readHeartbeat() {
  try {
    return JSON.parse(fs.readFileSync(HEARTBEAT, 'utf8'));
  } catch {
    return null;
  }
}

function start() {
  childStartedAt = Date.now();
  child = spawn(process.execPath, [path.join(ROOT, 'src', 'index.js')], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  log('INFO', `Started the watcher (pid ${child.pid}).`);

  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) return;
    // A refusal is a decision, not a fault: the watcher inspected its config or found another
    // instance and declined. Restarting just reprints the same message every five seconds and
    // buries the one line that explains what to fix.
    if (code === EXIT_REFUSED_TO_START) {
      log('ERROR', 'The watcher refused to start (see its message above). Not retrying - this needs a fix, not another attempt.');
      process.exit(1);
    }
    log('WARN', `Watcher exited (code ${code}, signal ${signal || 'none'}).`);
    scheduleRestart();
  });
  child.on('error', (err) => {
    log('ERROR', `Could not start the watcher: ${err.message}`);
  });
}

function scheduleRestart() {
  const now = Date.now();
  while (restartTimes.length && now - restartTimes[0] > RESTART_WINDOW_MS) restartTimes.shift();
  restartTimes.push(now);
  if (restartTimes.length > MAX_RESTARTS_IN_WINDOW) {
    log(
      'ERROR',
      `Restarted ${restartTimes.length} times in ${Math.round(RESTART_WINDOW_MS / 60000)} minutes - ` +
        'giving up rather than spinning. Something needs a human: check the log above for the ' +
        'reason the watcher keeps exiting.'
    );
    process.exit(1);
  }
  setTimeout(() => {
    if (!stopping) start();
  }, RESTART_DELAY_MS);
}

function restartChild(reason) {
  if (!child) return;
  log('WARN', `Restarting the watcher: ${reason}.`);
  const doomed = child;
  child = null;
  // SIGTERM first so the watcher's own handler can write its shutdown summary; a hard kill
  // follows only if it does not go quietly.
  doomed.kill('SIGTERM');
  const hardKill = setTimeout(() => doomed.kill('SIGKILL'), 10000);
  doomed.on('exit', () => {
    clearTimeout(hardKill);
    // On Windows a killed process never runs its Node signal handlers, so the child cannot
    // release its own lock. The supervisor knows exactly which pid it just stopped, so it
    // clears the lock on the child's behalf - otherwise every restart logs a stale-lock
    // takeover that means nothing to anyone.
    releaseInstanceLock(DATA_DIR, { pid: doomed.pid });
  });
  scheduleRestart();
}

setInterval(() => {
  if (!child || stopping) return;
  if (Date.now() - childStartedAt < GRACE_AFTER_START_MS) return;
  const reason = blindReason(readHeartbeat(), { pid: child.pid, staleAfterMs: STALE_AFTER_MS });
  if (reason) restartChild(reason);
}, CHECK_INTERVAL_MS);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    log('INFO', `Received ${signal}; stopping the watcher.`);
    const doomed = child;
    if (doomed) {
      doomed.kill('SIGINT'); // lets the watcher print its own summary where the OS allows it
      doomed.on('exit', () => releaseInstanceLock(DATA_DIR, { pid: doomed.pid }));
    }
    setTimeout(() => process.exit(0), 3000);
  });
}

log('INFO', `Supervising: restart on exit, and when the heartbeat is older than ${Math.round(STALE_AFTER_MS / 1000)}s or reports a blind state.`);
start();
