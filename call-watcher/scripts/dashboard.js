const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { loadConfig } = require('../src/loadConfig');
const { readShard, describeShard } = require('../src/shard');

const DATA_DIR = process.env.DASHBOARD_DATA || path.join(__dirname, '..', 'data');
const PAGE_PATH = path.join(__dirname, 'dashboard.html');
const GLOBAL_PAGE_PATH = path.join(__dirname, 'dashboard-all.html');
const LOG_TAIL_BYTES = 256 * 1024;
const STALE_HEARTBEAT_MS = 90 * 1000;

const config = loadConfig();
const port = Number(process.env.DASHBOARD_PORT || config.dashboardPort || 8477);
const host = process.env.DASHBOARD_HOST || '0.0.0.0';
const PEERS = (process.env.DASHBOARD_PEERS
  ? process.env.DASHBOARD_PEERS.split(',')
  : Array.isArray(config.peerDashboards)
    ? config.peerDashboards
    : []
)
  .map((entry) => String(entry).trim())
  .filter(Boolean);

function dayStamp(now = new Date()) {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function gitHead() {
  const gitDir = path.join(__dirname, '..', '..', '.git');
  try {
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (head.startsWith('ref: ')) {
      const ref = head.slice(5).trim();
      return fs.readFileSync(path.join(gitDir, ref), 'utf8').trim().slice(0, 7);
    }
    return head.slice(0, 7);
  } catch {
    return null;
  }
}

function pageVersion() {
  try {
    const stamp = fs.statSync(PAGE_PATH).mtime;
    const local = new Date(stamp.getTime() - stamp.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16).replace('T', ' ');
  } catch {
    return null;
  }
}

function requestedDay(url) {
  const asked = url.searchParams.get('day');
  if (!asked) return dayStamp();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asked)) return dayStamp();
  return asked;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function readOutcomes(day) {
  const file = path.join(DATA_DIR, `outcomes-${day}.jsonl`);
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      rows.push({ malformed: line.slice(0, 200) });
    }
  }
  return rows;
}

function tailLog(day, lines) {
  const file = path.join(DATA_DIR, `call-watcher-${day}.log`);
  let handle;
  try {
    handle = fs.openSync(file, 'r');
  } catch {
    return { lines: [], file: path.basename(file), missing: true };
  }
  try {
    const size = fs.fstatSync(handle).size;
    const start = Math.max(0, size - LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(handle, buffer, 0, buffer.length, start);
    const all = buffer.toString('utf8').split('\n').filter(Boolean);
    if (start > 0) all.shift();
    return { lines: all.slice(-lines), file: path.basename(file), missing: false, bytes: size };
  } finally {
    fs.closeSync(handle);
  }
}

function callsForDay(day) {
  const outcomes = readOutcomes(day);
  const processed = readJson(path.join(DATA_DIR, 'processed.json'), {});
  const byKey = new Map();

  for (const entry of outcomes) {
    if (!entry.symbol) continue;
    const key = `${entry.symbol}|${entry.fiscalPeriod}|${entry.earningsDate}`;
    const existing = byKey.get(key);
    const merged = {
      key,
      symbol: entry.symbol,
      fiscalPeriod: entry.fiscalPeriod,
      lastTs: entry.ts,
      status: entry.status,
      attempts: entry.attempts ?? existing?.attempts ?? null,
      error: entry.error || null,
      dialinUrl: entry.dialinUrl || existing?.dialinUrl || null,
      resolvedUrl: entry.resolvedUrl || null,
      pageTitle: entry.pageTitle || null,
      audioAudible: entry.audioAudible ?? null,
      startedBy: entry.startedBy || existing?.startedBy || null,
      durationSec: entry.durationSec ?? null,
      tries: (existing?.tries || 0) + 1,
    };
    if (existing && existing.status === 'started' && entry.status !== 'started') {
      merged.status = existing.status;
      merged.error = existing.error;
    }
    byKey.set(key, merged);
  }

  for (const [key, call] of byKey) {
    const record = processed[key];
    if (!record) continue;
    call.recordStatus = record.status;
    call.nextAttemptAt = record.nextAttemptAt || null;
  }

  return [...byKey.values()].sort((a, b) => String(b.lastTs).localeCompare(String(a.lastTs)));
}

function buildState(day) {
  const heartbeat = readJson(path.join(DATA_DIR, 'heartbeat.json'), null);
  const now = Date.now();
  const beatAge = heartbeat && heartbeat.updatedAt ? now - Date.parse(heartbeat.updatedAt) : null;

  let shard = null;
  try {
    shard = { ...readShard(config), description: describeShard(readShard(config)) };
  } catch (err) {
    shard = { error: err.message };
  }

  const calls = callsForDay(day);
  const upcoming = readJson(path.join(DATA_DIR, 'upcoming.json'), null);
  return {
    machine: os.hostname(),
    commit: gitHead(),
    pageVersion: pageVersion(),
    peers: PEERS,
    day,
    upcoming: upcoming && Array.isArray(upcoming.rows) ? upcoming.rows : [],
    upcomingAt: upcoming ? upcoming.updatedAt : null,
    now: new Date(now).toISOString(),
    shard,
    heartbeat,
    beatAgeSec: beatAge === null ? null : Math.round(beatAge / 1000),
    alive: beatAge !== null && beatAge < STALE_HEARTBEAT_MS,
    thresholdMinutes: config.thresholdMinutes,
    counts: {
      total: calls.length,
      started: calls.filter((c) => c.status === 'started').length,
      failed: calls.filter((c) => c.status === 'failed').length,
      silent: calls.filter((c) => c.status === 'started' && c.audioAudible === false).length,
    },
    calls,
  };
}

function send(res, status, body, type) {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return send(res, 400, 'bad request', 'text/plain');
  }

  if (url.pathname === '/api/state') {
    try {
      return send(res, 200, JSON.stringify(buildState(requestedDay(url))), 'application/json');
    } catch (err) {
      return send(res, 500, JSON.stringify({ error: err.message }), 'application/json');
    }
  }

  if (url.pathname === '/api/log') {
    const lines = Math.min(1000, Math.max(10, Number(url.searchParams.get('tail')) || 300));
    try {
      return send(res, 200, JSON.stringify(tailLog(requestedDay(url), lines)), 'application/json');
    } catch (err) {
      return send(res, 500, JSON.stringify({ error: err.message }), 'application/json');
    }
  }

  if (url.pathname === '/all' || url.pathname === '/all.html') {
    try {
      return send(res, 200, fs.readFileSync(GLOBAL_PAGE_PATH), 'text/html; charset=utf-8');
    } catch (err) {
      return send(res, 500, `dashboard-all.html could not be read: ${err.message}`, 'text/plain');
    }
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      return send(res, 200, fs.readFileSync(PAGE_PATH), 'text/html; charset=utf-8');
    } catch (err) {
      return send(res, 500, `dashboard.html could not be read: ${err.message}`, 'text/plain');
    }
  }

  return send(res, 404, 'not found', 'text/plain');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Set DASHBOARD_PORT to something else.`);
    process.exit(1);
  }
  console.error(`Dashboard server error: ${err.message}`);
  process.exit(1);
});

function start() {
  server.listen(port, host, () => {
    const addresses = Object.values(os.networkInterfaces())
      .flat()
      .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
      .map((entry) => entry.address);
    console.log(`Dashboard for ${os.hostname()} reading ${DATA_DIR}`);
    console.log(`  http://localhost:${port}`);
    for (const address of addresses) console.log(`  http://${address}:${port}`);
    console.log('Read-only: this process never writes to the data directory.');
  });
}

if (require.main === module) start();

module.exports = { requestedDay, dayStamp, callsForDay, buildState, tailLog, start };
