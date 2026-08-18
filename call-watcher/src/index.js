const fs = require('fs');
const path = require('path');
const config = require('../config.json');
const { StateStore } = require('./stateStore');
const { extractRows, minutesUntilCall, rowKey } = require('./tableWatcher');
const { resolveWebcastPage } = require('./webcastResolver');
const { fillRegistrationForm } = require('./formFiller');
const { triggerExtension } = require('./extensionTrigger');
const { connectToChrome, getOrOpenPortalPage } = require('./browserConnect');

function makeLogger() {
  const logPath = path.join(__dirname, '..', 'data', 'call-watcher.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const write = (level, msg) => {
    const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
    console.log(line);
    fs.appendFileSync(logPath, line + '\n');
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
function processRow(context, row, logger) {
  return withPipelineLock(async () => {
    logger.info(`Due: ${row.symbol} ${row.fiscalPeriod} (${row.transcriptionTimeText}) -> ${row.dialinLink}`);
    try {
      const page = await resolveWebcastPage(context, row.dialinLink, config, logger);
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
        logger.warn(`Could not parse time for ${row.symbol} ${row.fiscalPeriod}: "${row.transcriptionTimeText}"`);
        continue;
      }

      // Lower bound guards against re-triggering on a call that already started a while ago
      // (e.g. after a restart) where the countdown has gone negative.
      if (minsLeft <= config.thresholdMinutes && minsLeft > -5) {
        store.add(key); // claim immediately so the next poll (20s later) doesn't double-process
        processRow(context, row, logger);
      }
    }
  };

  await poll();
  setInterval(poll, config.pollIntervalMs);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
