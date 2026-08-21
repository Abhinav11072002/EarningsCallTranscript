const fs = require('fs');
const path = require('path');
const config = require('../config.json');
const { StateStore } = require('./stateStore');
const { extractRows, minutesUntilCall, rowKey } = require('./tableWatcher');
const { resolveDialinLinkByClick } = require('./dialinLinkClickResolver');
const { resolveWebcastPage } = require('./webcastResolver');
const { fillRegistrationForm } = require('./formFiller');
const { triggerExtension, hasActiveStream } = require('./extensionTrigger');
const { connectToChrome, getOrOpenPortalPage } = require('./browserConnect');
const { pruneOldLogLines } = require('./logRotation');

const LOG_PATH = path.join(__dirname, '..', 'data', 'call-watcher.log');
const LOG_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour - keeps the log from growing forever
const LOG_PRUNE_INTERVAL_MS = 15 * 60 * 1000;
const RECONNECT_DELAY_MS = 10000;
const RETRY_BASE_DELAY_MS = 30000;
const RETRY_MAX_DELAY_MS = 10 * 60 * 1000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeLogger() {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  const write = (level, msg) => {
    const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
    console.log(line);
    fs.appendFileSync(LOG_PATH, line + '\n');
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
function processRow(context, portalPage, row, key, store, logger) {
  return withPipelineLock(async () => {
    const startedAt = Date.now();
    let page;
    let transcriptionStarted = false;
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
      const registration = await fillRegistrationForm(page, config.dummyIdentity, logger);
      if (registration.pending) {
        const detail = registration.error ? `: ${registration.error}` : '';
        throw new Error(`Registration gate still appears active after filling and submission attempts${detail}`);
      }
      await triggerExtension(context, page, row, config, logger);
      transcriptionStarted = true;
      store.markStarted(key);
      logger.info(`Done: ${row.symbol} ${row.fiscalPeriod} (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
    } catch (err) {
      logger.error(`Failed processing ${row.symbol} ${row.fiscalPeriod}: ${err.message}`);
      const attempts = store.get(key)?.attempts || 1;
      const retryDelay = Math.min(RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_DELAY_MS);
      store.fail(key, err.message, retryDelay);
    } finally {
      if (page && !transcriptionStarted) await page.close().catch(() => {});
    }
  });
}

async function main() {
  const logger = makeLogger();
  const store = new StateStore(path.join(__dirname, '..', 'data', 'processed.json'));

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
      rows = await extractRows(portalPage);
    } catch (err) {
      if (!/target page, context or browser has been closed/i.test(err.message)) {
        logger.error(`Failed reading table: ${err.message}`);
        return;
      }
      logger.warn('Browser session or portal page closed; reconnecting and resuming table polling.');
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
    if (pollCount === 1 || pollCount % 30 === 0) {
      const withLinks = rows.filter((r) => r.dialinLink).length;
      logger.info(`Poll #${pollCount}: watching ${rows.length} row(s), ${withLinks} with a dial-in link.`);
    }

    for (const row of rows) {
      if (!row.dialinLink) continue;

      const key = rowKey(row);
      const record = store.get(key);
      const minsLeft = minutesUntilCall(row);
      if (minsLeft === null) {
        const warnKey = `${key}|${row.transcriptionTimeText}`;
        if (!warnedUnparseable.has(warnKey)) {
          warnedUnparseable.add(warnKey);
          logger.warn(`Could not parse time for ${row.symbol} ${row.fiscalPeriod}: "${row.transcriptionTimeText}"`);
        }
        continue;
      }

      // Keep a configurable post-start retry window so a manually stopped transcription can
      // be reacquired during a long call without replaying calls from previous days.
      const retryWindowMinutes = Number(config.retryWindowMinutes ?? 5);
      if (minsLeft <= config.thresholdMinutes && minsLeft > -retryWindowMinutes) {
        if (record) {
          let active;
          try {
            active = await hasActiveStream(context, config, row);
          } catch (err) {
            logger.warn(`Could not check active transcription for ${row.symbol} ${row.fiscalPeriod}: ${err.message}`);
            continue;
          }
          if (active) {
            if (record.status !== 'started') store.markStarted(key);
            continue;
          }
          if (record.status === 'started') {
            store.remove(key);
            logger.info(`No active transcription found for ${row.symbol} ${row.fiscalPeriod}; allowing retry.`);
          } else if (!store.retryDue(key) || record.attempts >= Number(config.maxAttempts ?? 4)) {
            continue;
          } else {
            store.remove(key);
          }
        }
        store.claim(key); // claim immediately so the next poll does not double-process
        processRow(context, portalPage, row, key, store, logger);
      }
    }
    } finally {
      pollRunning = false;
    }
  };

  await poll();
  setInterval(poll, config.pollIntervalMs);

  pruneOldLogLines(LOG_PATH, LOG_MAX_AGE_MS);
  setInterval(() => pruneOldLogLines(LOG_PATH, LOG_MAX_AGE_MS), LOG_PRUNE_INTERVAL_MS);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
