const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./loadConfig');
const { StateStore } = require('./stateStore');
const { extractRows, minutesUntilCall, rowKey } = require('./tableWatcher');
const { resolveDialinLinkByClick } = require('./dialinLinkClickResolver');
const { resolveWebcastPage } = require('./webcastResolver');
const { fillRegistrationForm } = require('./formFiller');
const { triggerExtension, getActiveStreams, streamMatchesRow } = require('./extensionTrigger');
const { connectToChrome, getOrOpenPortalPage } = require('./browserConnect');
const { resolveLogPath, pruneOldLogFiles } = require('./logRotation');
const { createObservability } = require('./observability');
const { checkChromeLaunchFlags } = require('./preflight');

const config = loadConfig();

// Checked at startup rather than discovered at the worst possible moment. The popup is driven
// through the global WebSocket class (Node 22+); on an older runtime everything up to that
// point works - scraping, resolution, registration - and then EVERY call fails at the final
// step with a bare ReferenceError, which reads like a bug in the extension rather than a
// runtime mismatch. package.json's "engines" only warns at install time.
const MIN_NODE_MAJOR = 22;
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (!Number.isNaN(nodeMajor) && nodeMajor < MIN_NODE_MAJOR) {
  console.error(
    `call-watcher needs Node ${MIN_NODE_MAJOR}+ (found ${process.versions.node}). ` +
      'The extension popup is driven over a WebSocket using the global WebSocket class, ' +
      'which older versions do not expose - every call would fail at the final step.'
  );
  process.exit(1);
}
if (typeof WebSocket === 'undefined') {
  console.error(
    `This Node build does not expose a global WebSocket (found ${process.versions.node}). ` +
      'Run with Node 22+ so the extension popup can be driven.'
  );
  process.exit(1);
}

const DATA_DIR = path.join(__dirname, '..', 'data');
const LOG_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const RECONNECT_DELAY_MS = 10000;
const RETRY_BASE_DELAY_MS = 30000;
const RETRY_MAX_DELAY_MS = 10 * 60 * 1000;
const CALL_DEADLINE_MS = 5 * 60 * 1000;
const READ_TABLE_TIMEOUT_MS = 20000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeLogger() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const write = (level, msg) => {
    const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
    console.log(line);
    try {
      // Path is resolved per write so the file rolls over at midnight on its own.
      fs.appendFileSync(resolveLogPath(DATA_DIR), line + '\n');
    } catch {
      // Never let a log write kill the run - a transient file lock (antivirus, backup agent)
      // on a work laptop would otherwise take down the whole day from inside a setInterval.
    }
  };
  return {
    info: (m) => write('INFO', m),
    warn: (m) => write('WARN', m),
    error: (m) => write('ERROR', m),
  };
}

// Each due call's whole pipeline (resolve webcast link -> fill registration form -> trigger
// extension) runs one at a time, front-to-back, through this queue - not just the
// extension-trigger step. Two reasons: (1) the extension's popup auto-closes as soon as its
// tab loses focus, so triggerExtension() needs exclusive control of "which tab is active"
// for its duration anyway; (2) webcast pages and registration forms vary a lot in layout, and
// formFiller.js's field-matching is a best-effort heuristic - running several unfamiliar pages
// at once makes a mis-fill on one call easy to miss in the interleaved logs. Serializing keeps
// each call's outcome easy to see and verify before the next one starts. If simultaneous calls
// ever back up meaningfully behind this queue, that's a sign to reconsider - but correctness
// per call matters more here than throughput.
let pipelineQueue = Promise.resolve();
let queuedPipelines = 0;
function withPipelineLock(fn) {
  queuedPipelines++;
  const run = () => fn().finally(() => queuedPipelines--);
  const result = pipelineQueue.then(run, run);
  pipelineQueue = result.catch(() => {});
  return result;
}

// Queued (not awaited) from the poll loop, so poll() keeps scanning for newly-due rows while
// this one waits its turn; the dedupe store claims the row before this is called.
function processRow(context, portalPage, row, key, store, logger, obs, minsLeftAtDispatch) {
  return withPipelineLock(async () => {
    const startedAt = Date.now();
    let page;
    let transcriptionStarted = false;
    let resolvedUrl = null;
    let pageTitle = null;
    logger.info(`Due: ${row.symbol} ${row.fiscalPeriod} (${row.transcriptionTimeText}) -> ${row.dialinLink} [queue=${queuedPipelines}]`);
    try {
      // The portal truncates long dial-in links for display (a real truncated string, not
      // just CSS - see tableWatcher.js), but clicking the cell live opens a new tab to the
      // correct, full destination anyway, since the click handler has the complete URL in its
      // own component state. Resolved first so the rest of the pipeline below is completely
      // unaffected either way - it only ever sees a normal, complete URL.
      let dialinLink = row.dialinLink;
      if (dialinLink.endsWith('...')) {
        dialinLink = await resolveDialinLinkByClick(context, portalPage, row.symbol, logger);
      }

      page = await resolveWebcastPage(context, dialinLink, config, logger);
      resolvedUrl = page.url();
      const registration = await fillRegistrationForm(page, config.dummyIdentity, logger);
      if (registration.pending) {
        const detail = registration.error ? `: ${registration.error}` : '';
        throw new Error(`Registration gate still appears active after filling and submission attempts${detail}`);
      }
      // Hard ceiling as defence in depth. Every individual step is bounded now, but this runs
      // inside the pipeline lock, so any future unbounded wait in here would stall not just
      // this call but every later one for the rest of the day.
      await Promise.race([
        triggerExtension(context, page, row, config, logger),
        delay(CALL_DEADLINE_MS).then(() => {
          throw new Error(`Trigger exceeded the ${CALL_DEADLINE_MS / 1000}s per-call deadline`);
        }),
      ]);
      transcriptionStarted = true;
      pageTitle = await page.title().catch(() => null);
      store.markStarted(key);
      logger.info(`Done: ${row.symbol} ${row.fiscalPeriod} (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
      obs.recordOutcome({
        status: 'started',
        symbol: row.symbol,
        fiscalPeriod: row.fiscalPeriod,
        earningsDate: row.earningsDate,
        dialinUrl: row.dialinLink,
        resolvedUrl,
        pageTitle,
        durationSec: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
        // Negative minsLeft means the call had already begun when we dispatched it.
        secondsLateVsScheduled: minsLeftAtDispatch === undefined ? null : Math.round(-minsLeftAtDispatch * 60),
        attempts: store.get(key)?.attempts ?? null,
      });
    } catch (err) {
      logger.error(`Failed processing ${row.symbol} ${row.fiscalPeriod}: ${err.message}`);
      const attempts = store.get(key)?.attempts || 1;
      const retryDelay = Math.min(RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_DELAY_MS);
      store.fail(key, err.message, retryDelay);
      obs.recordOutcome({
        status: 'failed',
        symbol: row.symbol,
        fiscalPeriod: row.fiscalPeriod,
        earningsDate: row.earningsDate,
        dialinUrl: row.dialinLink,
        resolvedUrl,
        error: err.message,
        durationSec: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
        attempts,
        retryInSec: Math.round(retryDelay / 1000),
      });
    } finally {
      if (page && !transcriptionStarted) await page.close().catch(() => {});
    }
  });
}

async function main() {
  const logger = makeLogger();
  const store = new StateStore(path.join(__dirname, '..', 'data', 'processed.json'));
  const obs = createObservability(DATA_DIR, logger);

  let browser;
  let context;
  let portalPage;
  const reconnect = async () => {
    const connection = await connectToChrome(config.cdpUrl);
    browser = connection.browser;
    context = connection.context;
    portalPage = await getOrOpenPortalPage(context, config.portalUrl);
  };
  while (true) {
    try {
      await reconnect();
      break;
    } catch (err) {
      logger.warn(`Chrome is unavailable; retrying in ${RECONNECT_DELAY_MS / 1000}s: ${err.message}`);
      await delay(RECONNECT_DELAY_MS);
    }
  }
  logger.info(`Portal tab URL: ${portalPage.url()}`);

  const flags = await checkChromeLaunchFlags(config.cdpUrl);
  if (flags.status === 'missing-capture-flag') {
    logger.error(
      'Chrome was launched WITHOUT --auto-accept-this-tab-capture. Registration and joining ' +
        'will appear to work, but every capture will be blocked by a native consent bubble that ' +
        'no automation can dismiss. Relaunch Chrome with the flag (see README) before relying on this.'
    );
  } else if (flags.status === 'no-matching-chrome') {
    logger.warn(`Could not find a chrome.exe with --remote-debugging-port on its command line, though CDP connected. Skipping the launch-flag check.`);
  } else if (flags.status === 'unknown') {
    logger.warn(`Could not verify Chrome's launch flags: ${flags.detail || 'unknown reason'}`);
  } else {
    logger.info('Preflight: Chrome has --auto-accept-this-tab-capture.');
  }

  logger.info(`Watching table every ${config.pollIntervalMs}ms, threshold ${config.thresholdMinutes} min`);

  let pollCount = 0;
  // Warn about an unparseable time once per distinct (row, text) combo, not every 20-second
  // poll forever - a row stuck on a format we can't read would otherwise flood the log with
  // an identical warning indefinitely.
  const warnedUnparseable = new Set();
  let pollRunning = false;
  const poll = async () => {
    if (pollRunning) {
      logger.warn('Skipping overlapping poll; previous poll is still running.');
      return;
    }
    pollRunning = true;
    try {
    let rows;
    try {
      // Bounded: page.evaluate has no timeout of its own, and the portal window also holds
      // every call's still-live capture tab. A wedged renderer used to leave pollRunning true
      // forever, after which the only output was "Skipping overlapping poll" every 20s.
      rows = await Promise.race([
        extractRows(portalPage),
        delay(READ_TABLE_TIMEOUT_MS).then(() => {
          throw new Error(`Reading the table exceeded ${READ_TABLE_TIMEOUT_MS / 1000}s`);
        }),
      ]);
    } catch (err) {
      // Any read failure is treated as "the session might be gone" and triggers a reconnect.
      // Allow-listing one exact message meant every other disconnect string (Target closed,
      // Session closed, socket hang up, WebSocket error) logged forever without recovering.
      logger.warn(`Failed reading table (${err.message}); reconnecting and resuming.`);
      try {
        await browser.close().catch(() => {});
        await reconnect();
        rows = await extractRows(portalPage);
      } catch (recoveryError) {
        logger.error(`Failed reconnecting to Chrome: ${recoveryError.message}`);
        return;
      }
    }

    pollCount++;
    const withLinks = rows.filter((r) => r.dialinLink).length;
    if (pollCount === 1 || pollCount % 30 === 0) {
      logger.info(`Poll #${pollCount}: watching ${rows.length} row(s), ${withLinks} with a dial-in link.`);
    }
    // Escalate the two states that are indistinguishable from a quiet day in the log but mean
    // we are blind: a renamed column header or an expired portal session both yield rows we
    // can see but no links to act on (or no rows at all), forever, silently.
    if (rows.length === 0) {
      logger.error('Table produced ZERO rows - portal session may have expired, or the view/markup changed. No calls can be detected in this state.');
    } else if (withLinks === 0) {
      logger.error(`Table produced ${rows.length} row(s) but ZERO dial-in links - the "Dialin Link" column may have been renamed or moved. No calls can be detected in this state.`);
    }

    // Pass 1: decide which rows are actionable, without touching Chrome. Collecting them
    // first lets us read the extension's stream list once for the whole poll instead of once
    // per row, and lets us act on the most urgent call first.
    const retryWindowMinutes = Number(config.retryWindowMinutes ?? 5);
    const lateStartGraceMinutes = Number(config.lateStartGraceMinutes ?? 10);
    const dueRows = [];
    for (const row of rows) {
      if (!row.dialinLink) continue;

      const key = rowKey(row);
      const minsLeft = minutesUntilCall(row);
      if (minsLeft === null) {
        const warnKey = `${key}|${row.transcriptionTimeText}`;
        if (!warnedUnparseable.has(warnKey)) {
          warnedUnparseable.add(warnKey);
          logger.warn(`Could not parse time for ${row.symbol} ${row.fiscalPeriod}: "${row.transcriptionTimeText}"`);
        }
        continue;
      }
      if (minsLeft > config.thresholdMinutes) continue;

      // The post-start window exists so a manually stopped transcription can be reacquired
      // during a long call, without replaying calls from previous days.
      if (minsLeft <= -retryWindowMinutes) continue;

      const record = store.get(key);
      // A call we have never attempted should not be started long after it began: joining an
      // hour late still "succeeds" and gets logged as Done, which makes a total miss look
      // like a capture. Reacquiring a call we DID start is still allowed for the full window.
      if (!record && minsLeft <= -lateStartGraceMinutes) {
        const warnKey = `late|${key}`;
        if (!warnedUnparseable.has(warnKey)) {
          warnedUnparseable.add(warnKey);
          logger.warn(
            `Skipping ${row.symbol} ${row.fiscalPeriod}: never attempted and already ` +
              `${Math.abs(minsLeft).toFixed(0)} min past start (grace ${lateStartGraceMinutes} min) - treating as missed.`
          );
          obs.recordOutcome({
            status: 'skipped-late',
            symbol: row.symbol,
            fiscalPeriod: row.fiscalPeriod,
            earningsDate: row.earningsDate,
            dialinUrl: row.dialinLink,
            minsPastStart: Number(Math.abs(minsLeft).toFixed(1)),
          });
        }
        continue;
      }
      dueRows.push({ row, key, record, minsLeft });
    }

    obs.heartbeat({
      rowsSeen: rows.length,
      withLinks,
      dueNow: dueRows.length,
      queueDepth: queuedPipelines,
      chromeConnected: browser.isConnected(),
    });

    if (!dueRows.length) return;
    // Soonest first: calls cluster on the hour and half-hour, and the pipeline is serialized,
    // so geometry order could leave the most imminent call waiting behind less urgent ones.
    dueRows.sort((a, b) => a.minsLeft - b.minsLeft);

    // One read for the whole poll, taken INSIDE the pipeline lock. Reading the extension's
    // storage requires opening an extension page, and an opening tab destroys any live
    // extension popup (verified directly) - so doing this outside the lock used to kill the
    // popup of a pipeline that was mid-trigger, wedging that call.
    let streams = null;
    if (dueRows.some((d) => d.record)) {
      try {
        streams = await withPipelineLock(() => getActiveStreams(context, config));
      } catch (err) {
        logger.warn(`Could not read active transcriptions: ${err.message}`);
      }
    }

    // Pass 2: reconcile against what the extension is actually recording, then dispatch.
    for (const { row, key, record, minsLeft } of dueRows) {
      if (record) {
        if (streams === null) continue; // cannot verify; try again next poll rather than guess
        if (streamMatchesRow(streams, row)) {
          if (record.status !== 'started') store.markStarted(key);
          continue;
        }
        if (record.status === 'started') {
          // It was recording and no longer is (stopped by hand, or the tab/extension died).
          // Dropping the record deliberately restarts the attempt series for this fresh
          // problem rather than counting it against the earlier successful start.
          store.remove(key);
          logger.info(`No active transcription found for ${row.symbol} ${row.fiscalPeriod}; allowing retry.`);
        } else if (!store.retryDue(key) || record.attempts >= Number(config.maxAttempts ?? 4)) {
          continue;
        }
        // Deliberately NOT removing the record on the retry path: claim() derives the next
        // attempt number from the existing one, so deleting first pinned attempts at 1 - which
        // silently disabled maxAttempts and kept the backoff at its base delay forever.
      }
      store.claim(key); // claim immediately so the next poll does not double-process
      processRow(context, portalPage, row, key, store, logger, obs, minsLeft);
    }
    } catch (err) {
      // poll() runs from setInterval, so anything escaping here becomes an unhandled rejection
      // and (on Node 22+) terminates the process. A single locked state file or log write must
      // not end the trading day - log it and let the next tick try again.
      logger.error(`Unexpected error during poll: ${err && err.stack ? err.stack : err}`);
    } finally {
      pollRunning = false;
    }
  };

  await poll();
  setInterval(poll, config.pollIntervalMs);

  const retentionDays = Number(config.logRetentionDays ?? 14);
  const sweepLogs = () => {
    const removed = pruneOldLogFiles(DATA_DIR, retentionDays);
    if (removed.length) logger.info(`Removed ${removed.length} log file(s) older than ${retentionDays} days.`);
  };
  sweepLogs();
  setInterval(sweepLogs, LOG_PRUNE_INTERVAL_MS);
}

// A crash used to leave nothing behind but a closed terminal: fatal errors went to the console
// only, and there were no process-level handlers at all. Anything that kills this process must
// leave a durable, timestamped record, or "it silently stopped at 09:40" is unanswerable.
const fatalLogger = makeLogger();

process.on('unhandledRejection', (reason) => {
  fatalLogger.error(`FATAL unhandled rejection: ${reason && reason.stack ? reason.stack : reason}`);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  fatalLogger.error(`FATAL uncaught exception: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    fatalLogger.info(`Received ${signal}; shutting down. Tabs already opened for in-flight calls are left open.`);
    // Print the day's tally on the way out so stopping the watcher leaves a checkable record
    // rather than an impression. Read back from the ledger, so it is correct across restarts.
    try {
      const summary = createObservability(DATA_DIR, fatalLogger).summarize();
      fatalLogger.info(
        `Summary for ${summary.date}: started=${summary.started.length}, ` +
          `failed=${summary.failed.length}, skipped-late=${summary.skippedLate.length}, ` +
          `recovered-on-retry=${summary.retriedThenStarted.length}`
      );
      for (const f of summary.failed) fatalLogger.info(`  FAILED  ${f.label}: ${f.error}`);
      for (const s of summary.skippedLate) fatalLogger.info(`  MISSED  ${s.label} (${s.minsPastStart} min past start)`);
      const late = summary.started.filter((s) => (s.lateBySec ?? 0) > 60);
      for (const s of late) fatalLogger.info(`  LATE    ${s.label} started ${s.lateBySec}s after the scheduled time`);
    } catch (err) {
      fatalLogger.warn(`Could not produce the daily summary: ${err.message}`);
    }
    process.exit(0);
  });
}

main().catch((err) => {
  fatalLogger.error(`FATAL during startup: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
