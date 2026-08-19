const fs = require('fs');
const path = require('path');
const config = require('../config.json');
const { StateStore } = require('./stateStore');
const { extractRows, minutesUntilCall, rowKey } = require('./tableWatcher');
const { resolveDialinLinkByClick } = require('./dialinLinkClickResolver');
const { resolveWebcastPage } = require('./webcastResolver');
const { fillRegistrationForm } = require('./formFiller');
const { triggerExtension } = require('./extensionTrigger');
const { connectToChrome, getOrOpenPortalPage } = require('./browserConnect');
const { pruneOldLogLines } = require('./logRotation');

const LOG_PATH = path.join(__dirname, '..', 'data', 'call-watcher.log');
const LOG_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour - keeps the log from growing forever
const LOG_PRUNE_INTERVAL_MS = 15 * 60 * 1000;

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
function withPipelineLock(fn) {
  const result = pipelineQueue.then(fn, fn);
  pipelineQueue = result.catch(() => {});
  return result;
}

// Queued (not awaited) from the poll loop, so poll() keeps scanning for newly-due rows while
// this one waits its turn; the dedupe store already claimed the row before this was called.
function processRow(context, portalPage, row, logger) {
  return withPipelineLock(async () => {
    logger.info(`Due: ${row.symbol} ${row.fiscalPeriod} (${row.transcriptionTimeText}) -> ${row.dialinLink}`);
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

      const page = await resolveWebcastPage(context, dialinLink, config, logger);
      await fillRegistrationForm(page, config.dummyIdentity, logger);
      await triggerExtension(context, page, row, config, logger);
      logger.info(`Done: ${row.symbol} ${row.fiscalPeriod}`);
    } catch (err) {
      logger.error(`Failed processing ${row.symbol} ${row.fiscalPeriod}: ${err.message}`);
    }
  });
}

async function main() {
  const logger = makeLogger();
  const store = new StateStore(path.join(__dirname, '..', 'data', 'processed.json'));

  logger.info('Connecting to Chrome...');
  const { context } = await connectToChrome(config.cdpUrl);
  const portalPage = await getOrOpenPortalPage(context, config.portalUrl);
  logger.info(`Portal tab URL: ${portalPage.url()}`);
  logger.info(`Watching table every ${config.pollIntervalMs}ms, threshold ${config.thresholdMinutes} min`);

  let pollCount = 0;
  // Warn about an unparseable time once per distinct (row, text) combo, not every 20-second
  // poll forever - a row stuck on a format we can't read would otherwise flood the log with
  // an identical warning indefinitely.
  const warnedUnparseable = new Set();
  const poll = async () => {
    let rows;
    try {
      rows = await extractRows(portalPage);
    } catch (err) {
      logger.error(`Failed reading table: ${err.message}`);
      return;
    }

    pollCount++;
    if (pollCount === 1 || pollCount % 30 === 0) {
      const withLinks = rows.filter((r) => r.dialinLink).length;
      logger.info(`Poll #${pollCount}: watching ${rows.length} row(s), ${withLinks} with a dial-in link.`);
    }

    for (const row of rows) {
      if (!row.dialinLink) continue;

      const key = rowKey(row);
      if (store.has(key)) continue;

      const minsLeft = minutesUntilCall(row);
      if (minsLeft === null) {
        const warnKey = `${key}|${row.transcriptionTimeText}`;
        if (!warnedUnparseable.has(warnKey)) {
          warnedUnparseable.add(warnKey);
          logger.warn(`Could not parse time for ${row.symbol} ${row.fiscalPeriod}: "${row.transcriptionTimeText}"`);
        }
        continue;
      }

      // Lower bound guards against re-triggering on a call that already started a while ago
      // (e.g. after a restart) where the countdown has gone negative.
      if (minsLeft <= config.thresholdMinutes && minsLeft > -5) {
        store.add(key); // claim immediately so the next poll (20s later) doesn't double-process
        processRow(context, portalPage, row, logger);
      }
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
