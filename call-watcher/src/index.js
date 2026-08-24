const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./loadConfig');
const { StateStore } = require('./stateStore');
const { extractRows, minutesUntilCall, rowKey, stampDueAt, minutesRemaining } = require('./tableWatcher');
const { resolveDialinLinkByClick } = require('./dialinLinkClickResolver');
const { resolveWebcastPage } = require('./webcastResolver');
const { fillRegistrationForm } = require('./formFiller');
const { advanceJoinFlow } = require('./joinFlow');
const { shouldSkipAsLate } = require('./dispatchRules');
const { Mutex, withDeadline, runPreparedBatch } = require('./concurrency');
const { triggerExtension, getActiveStreams, streamMatchesRow, splitFiscalPeriod } = require('./extensionTrigger');
const { connectToChrome, getOrOpenPortalPage } = require('./browserConnect');
const { resolveLogPath, pruneOldLogFiles } = require('./logRotation');
const { createObservability } = require('./observability');
const { checkChromeLaunchFlags } = require('./preflight');
const { CallTabRegistry } = require('./callTabs');
const { validateConfig } = require('./validateConfig');
const { acquireInstanceLock, releaseInstanceLock, refreshInstanceLock } = require('./instanceLock');
const { SeenLog, reconcile, formatReconciliation, seenPathFor } = require('./reconciliation');

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
// Distinct from a crash. A crash is worth retrying - a network blip, a Chrome restart. A
// deliberate refusal (bad config, another watcher already running) will refuse identically
// every time, so a supervisor must stop rather than loop. Named after sysexits.h's EX_CONFIG.
const EXIT_REFUSED_TO_START = 78;
const LOG_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const RECONNECT_DELAY_MS = 10000;
const RETRY_BASE_DELAY_MS = 30000;
const RETRY_MAX_DELAY_MS = 10 * 60 * 1000;
// Two separate ceilings, both deliberately much tighter than the single 5-minute one they
// replace. That figure was set when calls ran strictly one at a time and a slow call merely
// delayed the next; now that an attempt must finish before its call starts, a call allowed to
// run for five minutes can push several later calls past their start time and lose them
// outright. Neither bound is reachable by a healthy call: the trigger's own steps add up to
// about 66s worst case (shortcut 30s + popup 18s + CDP 10s + stream confirm 8s), and
// preparation is a page load plus at most two navigation hops.
const PREPARE_DEADLINE_MS = Number(config.prepareDeadlineMs ?? 120000);
const TRIGGER_DEADLINE_MS = Number(config.triggerDeadlineMs ?? 90000);

// Clicking a truncated dial-in link happens on the SHARED portal tab: it clicks a cell and
// waits for the tab that opens. Two of those interleaved cannot tell which new tab belongs to
// which click, so a call would be handed another row's URL. Preparation is otherwise parallel;
// this one step is not.
const portalClickMutex = new Mutex();
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

// Serializes whole BATCHES, so two overlapping polls can never interleave their trigger
// phases. Within a batch, preparation runs in parallel and only the trigger is exclusive -
// concurrency.js explains why that split is safe and why the trigger cannot be shared.
//
// queuedPipelines therefore counts batches in flight, not individual calls. Its one job is to
// keep the extension-storage read (which opens a tab, and an opening tab kills a live popup)
// away from a batch that is mid-trigger.
let pipelineQueue = Promise.resolve();
let queuedPipelines = 0;
function withPipelineLock(fn) {
  queuedPipelines++;
  const run = () => fn().finally(() => queuedPipelines--);
  const result = pipelineQueue.then(run, run);
  pipelineQueue = result.catch(() => {});
  return result;
}

// The pipeline is split in two because only the second half needs exclusivity.
//
// prepareCall touches nothing but its own tab: it resolves the link, opens the page, walks any
// join screens and fills any registration form. Several of these run at once.
//
// triggerCall brings a tab to the foreground and drives the extension popup, which closes the
// moment its tab loses focus. That cannot overlap with anything - not with another trigger, and
// not with a tab being opened by a preparation - so triggers run strictly one at a time, after
// every preparation in the batch has finished. Both facts were established the hard way here:
// an unrelated context.newPage() was verified to kill an open popup, and a capture started
// while the wrong tab held focus records the wrong tab.
async function prepareCall(context, portalPage, row, key, logger) {
  const startedAt = Date.now();
  let page = null;
  // Declared here on purpose. This used to live outside the try in the old single-function
  // pipeline; extracting the preparation half left the assignment behind without its
  // declaration, which in non-strict mode makes it an implicit GLOBAL - shared by every
  // preparation running at once, so two calls preparing together would overwrite each other's
  // resolved URL and the ledger would attribute the wrong page to a call. Harmless while the
  // pipeline was strictly serial; a data-corruption bug the moment it stopped being.
  let resolvedUrl = null;
  try {
    const prepared = await withDeadline(
      (async () => {
        logger.info(`Preparing ${row.symbol} ${row.fiscalPeriod} (${row.transcriptionTimeText}) -> ${row.dialinLink}`);
        // The portal truncates long dial-in links for display (a real truncated string, not
        // just CSS - see tableWatcher.js), but clicking the cell live opens a new tab to the
        // correct, full destination anyway, since the click handler has the complete URL in its
        // own component state. Resolved first so the rest of the pipeline below is completely
        // unaffected either way - it only ever sees a normal, complete URL.
        let dialinLink = row.dialinLink;
        // Matches a real ellipsis character too, and an ellipsis anywhere rather than only at the
        // end. About 40% of links depend on this detector, so a frontend tweak from "..." to "…"
        // would otherwise silently send us to a truncated URL - which, for a provider prefix like
        // "https://edge.media-server.com/mmc/p/", still matches a known domain and gets recorded
        // as if it were the call.
        if (/(\.{3}|…)/.test(dialinLink)) {
          const truncatedPrefix = dialinLink.replace(/(\.{3}|…).*$/, '');
          // Serialized: see portalClickMutex.
          dialinLink = await portalClickMutex.run(() =>
            resolveDialinLinkByClick(context, portalPage, row.symbol, logger)
          );
          // The click resolver finds the row by symbol text alone, so this guards against it
          // having matched a different row for the same ticker: the full URL must extend the
          // prefix the portal actually showed for THIS row.
          if (truncatedPrefix.length > 12 && !dialinLink.startsWith(truncatedPrefix)) {
            throw new Error(
              `Click-resolved link does not extend the truncated prefix shown for this row ` +
                `(expected it to start with "${truncatedPrefix}", got "${dialinLink}") - probably the wrong row`
            );
          }
        }

        // Hints let the resolver prefer THIS call's link when a page lists several quarters -
        // an events index often lists the archived quarter first, and DOM order is not relevance.
        const { year, period } = splitFiscalPeriod(row.fiscalPeriod);
        page = await resolveWebcastPage(context, dialinLink, config, logger, {
          symbol: row.symbol,
          year,
          period,
        });
        // Some providers gate the call on a choice of client rather than a form (Zoom's lobby
        // offers only "Join from Zoom Workplace app" and "Join from browser"). That has to be
        // resolved BEFORE the form filler runs, because the form we need - Zoom's "Your Name" -
        // only exists on the far side of it.
        // Reassigned, not just awaited: an entry link with target=_blank opens the call in its
        // own tab, and capture is per-tab - continuing with the old handle would record the lobby.
        page = await advanceJoinFlow(page, logger);
        // The callback keeps `page` current even if the form filler throws mid-way: it can
        // follow the call into a new tab and close the old one, and the catch below must clean
        // up the tab we actually hold, not the one we started with.
        const registration = await fillRegistrationForm(page, config.dummyIdentity, logger, (adopted) => {
          page = adopted;
        });
        if (registration.page) page = registration.page;
        // ...and again afterwards: a registration step can hand back a second client choice, and
        // Zoom's web client re-renders into the meeting only once the name form is submitted.
        page = await advanceJoinFlow(page, logger);
        // Read LAST, not before the form step. resolvedUrl is the field the ledger uses to
        // answer "was this the right page?", and registration can navigate - or follow the call
        // into an entirely different tab - after the earlier reading was taken. Recording the
        // pre-form URL made the ledger describe a page that was never captured.
        resolvedUrl = page.url();
        if (registration.pending) {
          const detail = registration.error ? `: ${registration.error}` : '';
          throw new Error(`Registration gate still appears active after filling and submission attempts${detail}`);
        }
        return { page, dialinLink, resolvedUrl };
      })(),
      PREPARE_DEADLINE_MS,
      `Preparation exceeded the ${PREPARE_DEADLINE_MS / 1000}s limit`
    );
    return { ok: true, ...prepared, startedAt };
  } catch (err) {
    // The tab is closed here rather than by the caller: preparation is the only phase that
    // creates one, and a failure that leaves it open leaks a tab per attempt.
    if (page) await page.close().catch(() => {});
    return { ok: false, error: err, startedAt, resolvedUrl };
  }
}

async function triggerCall(context, prepared, row, key, store, logger, obs, callTabs, minsLeftAtDispatch) {
  const { startedAt } = prepared;
  let page = prepared.page;
  let transcriptionStarted = false;
  let pageTitle = null;
  try {
    // Re-checked at the last possible moment. A call can pass the lateness gate at dispatch and
    // still cross its start time while earlier calls in the batch are being triggered - and the
    // rule is that an attempt begins before the call does, not that it was merely queued in
    // time. Cheap to check, and the alternative is a transcript missing the opening remarks.
    // minutesRemaining, not minutesUntilCall: the latter re-parses the countdown TEXT, which
    // was frozen at scrape time, so this guard silently never fired. See tableWatcher.stampDueAt.
    const minsLeftNow = minutesRemaining(row);
    if (minsLeftNow !== null && minsLeftNow <= 0) {
      throw new Error(
        `Call started ${Math.abs(minsLeftNow).toFixed(1)} min ago while it was queued for the trigger - not joining late`
      );
    }

    await withDeadline(
      triggerExtension(context, page, row, config, logger, prepared.dialinLink),
      TRIGGER_DEADLINE_MS,
      `Trigger exceeded the ${TRIGGER_DEADLINE_MS / 1000}s limit`
    );
    transcriptionStarted = true;
    pageTitle = await page.title().catch(() => null);
    store.markStarted(key);
    // Hand the tab to the registry instead of closing it: the capture lives in this tab, so
    // it must stay open until the call is over. The registry is what eventually closes it.
    callTabs.register(key, page, `${row.symbol} ${row.fiscalPeriod}`);
    logger.info(`Done: ${row.symbol} ${row.fiscalPeriod} (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
    obs.recordOutcome({
      status: 'started',
      symbol: row.symbol,
      fiscalPeriod: row.fiscalPeriod,
      earningsDate: row.earningsDate,
      dialinUrl: row.dialinLink,
      resolvedUrl: prepared.resolvedUrl,
      pageTitle,
      durationSec: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
      // Negative minsLeft means the call had already begun when we dispatched it.
      secondsLateVsScheduled: minsLeftAtDispatch === undefined ? null : Math.round(-minsLeftAtDispatch * 60),
      attempts: store.get(key)?.attempts ?? null,
    });
  } catch (err) {
    recordFailure(row, key, err, store, logger, obs, startedAt, prepared.resolvedUrl);
  } finally {
    if (page && !transcriptionStarted) await page.close().catch(() => {});
  }
}

function recordFailure(row, key, err, store, logger, obs, startedAt, resolvedUrl) {
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
}

// One batch of due calls: prepare them together, then trigger them one by one.
//
// The batch as a whole takes the pipeline lock, so two overlapping polls cannot interleave
// their trigger phases. Within a batch every symbol goes through exactly the same steps in
// exactly the same order - the only thing that differs is how many preparations are in flight
// beside it.
function runBatch(context, portalPage, batch, store, logger, obs, callTabs) {
  return withPipelineLock(async () => {
    const width = Math.max(1, Number(config.maxConcurrentPreparations ?? 3));
    logger.info(
      `Batch of ${batch.length} call(s): ${batch.map((b) => b.row.symbol).join(', ')} ` +
        `(preparing up to ${width} at a time, then triggering one at a time)`
    );

    await runPreparedBatch(batch, {
      width,
      prepare: ({ row, key }) => prepareCall(context, portalPage, row, key, logger),
      // prepareCall reports its own failures in-band rather than throwing, so that a bad call
      // cannot abort the batch; unwrap that here so both shapes reach recordFailure.
      trigger: (outcome, { row, key, minsLeft }) => {
        if (!outcome.ok) {
          recordFailure(row, key, outcome.error, store, logger, obs, outcome.startedAt, outcome.resolvedUrl);
          return undefined;
        }
        return triggerCall(context, outcome, row, key, store, logger, obs, callTabs, minsLeft);
      },
      // Only reached if prepareCall itself threw, which it is written not to do.
      onPrepareFailure: ({ row, key }, error) =>
        recordFailure(row, key, error, store, logger, obs, Date.now(), null),
    });
  });
}

async function main() {
  const logger = makeLogger();

  // First thing, before touching Chrome or the state files. Two watchers sharing one Chrome and
  // one data directory corrupt each other: processed.json is rewritten whole from memory, so
  // last-write-wins can erase a claim and dispatch the same call twice, and the extension popup
  // is a single global resource that the batch pipeline already serializes carefully within one
  // process. Observed during testing - two were running and the heartbeat described whichever
  // wrote last.
  // Set singleInstance=false in config.local.json to turn this into a warning. The guard is
  // worth having - two watchers double-record and corrupt each other's state, and that is far
  // harder to diagnose after the fact than a refused startup - but it is a judgement call about
  // one machine's usage, and it should be the operator's to make.
  const lock = acquireInstanceLock(DATA_DIR);
  if (!lock.ok && config.singleInstance === false) {
    logger.warn(
      `Another call-watcher appears to be running (pid ${lock.holder.pid}, started ${lock.holder.startedAt}), ` +
        'but singleInstance is disabled so this one is starting anyway. Two watchers on the same ' +
        'Chrome can record the same call twice and overwrite each other’s state.'
    );
  } else if (!lock.ok) {
    logger.error(
      `Another call-watcher is already running (pid ${lock.holder.pid}, started ${lock.holder.startedAt}). ` +
        'Two watchers on the same Chrome and data directory overwrite one another and can ' +
        'record the same call twice. Run "npm run stop" to stop it - that uses this lock file, ' +
        'so it finds the right process however it was launched. If you are certain it is gone, ' +
        'delete data/watcher.lock.'
    );
    process.exit(EXIT_REFUSED_TO_START);
  }
  if (lock.warning) logger.warn(`Instance lock: ${lock.warning}`);
  if (lock.takeover) {
    // Routine, not a problem: on Windows a watcher stopped by anything other than Ctrl+C never
    // runs its signal handlers, so it cannot release its own lock. Logged at info level because
    // seeing it on every supervised restart taught nothing and looked like a fault.
    logger.info(`Took over a stale instance lock from pid ${lock.takeover.pid} - ${lock.takeover.reason}.`);
  }
  const store = new StateStore(path.join(__dirname, '..', 'data', 'processed.json'), Number(config.stateRecordTtlDays ?? 7));
  const obs = createObservability(DATA_DIR, logger);
  const callTabs = new CallTabRegistry(logger);
  // Independent record of every row observed, so the end-of-day report can name calls that
  // never produced a ledger entry at all - the failures nothing else can see.
  let seenLog = new SeenLog(DATA_DIR, logger);

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

  // Validated after the logger exists so the findings reach the log file, not just a terminal
  // that may be closed by the time anyone looks. Errors stop the run: every numeric setting is
  // read as `config.x ?? default`, so a bad or misspelled one does not fail - it silently
  // substitutes a different value and the day proceeds under rules nobody chose.
  const configCheck = validateConfig(config);
  for (const w of configCheck.warnings) logger.warn(`Config: ${w}`);
  if (!configCheck.ok) {
    for (const e of configCheck.errors) logger.error(`Config: ${e}`);
    logger.error('Refusing to start with an invalid config - fix the entries above in config.json or config.local.json.');
    process.exit(EXIT_REFUSED_TO_START);
  }

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

  // Claims can only be live while the process that made them is alive, and none is at
  // startup - so anything still claimed was abandoned by a crash or a Ctrl+C mid-batch. Left
  // alone, retryDue() would refuse it for 30 minutes, which under the no-late-attempts rule
  // means the call is simply lost. Released BEFORE the revival below so a claim that has also
  // exhausted its attempts gets both treatments.
  const released = store.releaseStaleClaims();
  for (const r of released) {
    logger.warn(
      `Releasing an abandoned claim for ${r.key} (claimed ${r.claimedAt}, attempt ${r.attempts}) - ` +
        'the previous run exited while it was being processed.'
    );
  }

  // A restart is an explicit decision to try again - see StateStore.resetExhaustedFailures.
  const revived = store.resetExhaustedFailures(Number(config.maxAttempts ?? 4));
  for (const r of revived) {
    logger.info(`Retrying ${r.key} on this restart (it had used all ${r.attempts} attempts): ${r.lastError || 'no error recorded'}`);
  }

  logger.info(`Watching table every ${config.pollIntervalMs}ms, threshold ${config.thresholdMinutes} min`);

  let pollCount = 0;
  // Warn about an unparseable time once per distinct (row, text) combo, not every 20-second
  // poll forever - a row stuck on a format we can't read would otherwise flood the log with
  // an identical warning indefinitely.
  const warnedUnparseable = new Set();
  let pollRunning = false;
  // A persistent failure here silently wedges every row that has a record (no retries, no
  // reconciliation, no completion), while first attempts keep succeeding - so the log looks
  // healthy. Surfaced in the heartbeat so a watchdog can see it.
  let consecutiveStreamReadFailures = 0;
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
    // Matches config.json. It read 5 here, so a missing key silently shrank the post-start
    // reconciliation window by 24x - long enough to stop noticing that live calls had ended.
    const retryWindowMinutes = Number(config.retryWindowMinutes ?? 120);
    const lateStartGraceMinutes = Number(config.lateStartGraceMinutes ?? 0);
    const dueRows = [];
    let parseableTimes = 0;
    let linkedRows = 0;
    for (const row of rows) {
      // Deliberately observed BEFORE the no-link skip below, so a row that never gets a
      // dial-in link is still on the record rather than vanishing from the day entirely.
      if (!row.dialinLink) {
        seenLog.observe({
          key: rowKey(row),
          symbol: row.symbol,
          fiscalPeriod: row.fiscalPeriod,
          earningsDate: row.earningsDate,
          hasLink: false,
          timeParsed: minutesUntilCall(row) !== null,
          insideWindow: false,
        });
        continue;
      }
      linkedRows++;

      const key = rowKey(row);
      const minsLeft = minutesUntilCall(row);
      seenLog.observe({
        key,
        symbol: row.symbol,
        fiscalPeriod: row.fiscalPeriod,
        earningsDate: row.earningsDate,
        hasLink: Boolean(row.dialinLink),
        timeParsed: minsLeft !== null,
        insideWindow: minsLeft !== null && minsLeft <= config.thresholdMinutes,
      });
      if (minsLeft !== null) {
        parseableTimes++;
        // Freeze the countdown into an absolute instant now, while the text is fresh.
        stampDueAt(row, minsLeft);
      }
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
      // The whole attempt budget is spent BEFORE the call starts - see dispatchRules.js. This
      // covers retries as well as first attempts: previously only never-attempted calls were
      // gated, so a call that failed inside the window kept retrying long after it had begun,
      // burning the pipeline lock on a capture that could no longer be complete anyway.
      const late = shouldSkipAsLate({ minsLeft, record, lateStartGraceMinutes });
      if (late) {
        const warnKey = `late|${key}`;
        if (!warnedUnparseable.has(warnKey)) {
          warnedUnparseable.add(warnKey);
          logger.warn(
            `Missed ${row.symbol} ${row.fiscalPeriod}: ${late.reason}, and the call started ` +
              `${late.minsPastStart} min ago. Not going back to it - an attempt has to begin ` +
              `before the call does.`
          );
          obs.recordOutcome({
            status: 'skipped-late',
            symbol: row.symbol,
            fiscalPeriod: row.fiscalPeriod,
            earningsDate: row.earningsDate,
            dialinUrl: row.dialinLink,
            minsPastStart: late.minsPastStart,
            attempts: late.attempts,
            reason: late.reason,
          });
        }
        continue;
      }
      dueRows.push({ row, key, record, minsLeft });
    }

    // The third way to be blind, and the only one that had no alarm. Zero rows and zero links
    // are already escalated above; "plenty of rows, plenty of links, and not one readable time"
    // is what a change to the Transcription Time format looks like, and it is indistinguishable
    // from a quiet day: every row warns once, then nothing ever becomes due again, all day.
    if (linkedRows > 0 && parseableTimes === 0) {
      logger.error(
        `Table produced ${linkedRows} row(s) with dial-in links but NOT ONE readable ` +
          'Transcription Time - the time format has probably changed. No call can become due ' +
          'in this state. See tableWatcher.js (parseCountdownToMinutes / parseAbsoluteDateTimeToMinutes).'
      );
    }

    // Close tabs whose call is over. Without this every successful call leaves a tab holding a
    // live capture for as long as the process runs - fine for an afternoon, fatal over days.
    // `completed` is set by the reconciliation below; the age cap catches calls whose ending we
    // never observed (e.g. the extension was reloaded and its storage cleared).
    callTabs.sweep(
      (k) => store.get(k)?.status === 'completed',
      Number(config.maxCallTabMinutes ?? 180) * 60000
    );

    // One write per poll, not one per row. Also re-created if the day has rolled over, so a
    // process left running overnight starts a fresh day's record instead of appending to
    // yesterday's.
    if (seenLog.filePath !== seenPathFor(DATA_DIR)) {
      seenLog.flush(); // close out yesterday before switching files
      seenLog = new SeenLog(DATA_DIR, logger);
    }
    seenLog.flush();
    // Proves this process still holds the lock. Without it, a lock could only ever be cleared by
    // a clean exit, so a hard kill would block every future start until someone deleted the file.
    refreshInstanceLock(DATA_DIR);

    obs.heartbeat({
      rowsSeen: rows.length,
      withLinks,
      parseableTimes,
      dueNow: dueRows.length,
      queueDepth: queuedPipelines,
      openCallTabs: callTabs.size(),
      streamReadFailures: consecutiveStreamReadFailures,
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
    // Reading the extension's storage needs an extension tab, and an opening tab destroys any
    // live popup - so it must not happen while a pipeline is mid-trigger. Gating on an idle
    // queue achieves that WITHOUT joining the queue: an earlier version awaited the pipeline
    // lock here, which stalled polling and the heartbeat for the entire duration of every call
    // (minutes), so newly-due rows were not even noticed and a watchdog could not tell the
    // process from a dead one. When a pipeline is in flight, reconciliation simply waits for
    // the next poll; rows with no record are unaffected and still dispatch immediately.
    let streams = null;
    if (queuedPipelines === 0 && dueRows.some((d) => d.record)) {
      try {
        streams = await getActiveStreams(context, config);
        consecutiveStreamReadFailures = 0;
      } catch (err) {
        consecutiveStreamReadFailures++;
        logger.warn(
          `Could not read active transcriptions (${consecutiveStreamReadFailures} in a row): ${err.message}`
        );
      }
    }

    // Pass 2: reconcile against what the extension is actually recording, then dispatch.
    const reacquireGraceMinutes = Number(config.reacquireGraceMinutes ?? 30);
    const dispatchedThisPoll = new Set();
    const batch = [];
    for (const { row, key, minsLeft } of dueRows) {
      // Re-read rather than trusting the pass-1 snapshot: the table can yield the same logical
      // row twice (the geometry scrape buckets by position, so a cell and its wrapper can both
      // survive), and a stale snapshot made the second copy claim and dispatch the SAME call a
      // second time - two tabs, two triggers, and the first recording killed when the second
      // tab registered under the same key.
      if (dispatchedThisPoll.has(key)) continue;
      const record = store.get(key);
      if (record) {
        if (record.status === 'completed') continue; // terminal: this call already ran and ended
        if (streams === null) continue; // cannot verify; try again next poll rather than guess
        if (streamMatchesRow(streams, row)) {
          // Seeing it again clears any absence tally, so a transient blip cannot accumulate
          // across unrelated polls and eventually be mistaken for the call having ended.
          if (record.status !== 'started' || record.absentObservations) store.markStarted(key);
          continue;
        }
        if (record.status === 'started') {
          // It was recording and now is not. Two very different causes, and the difference
          // decides whether re-recording is correct:
          //   - soon after the scheduled start -> the call is probably still on and the stream
          //     was stopped by hand or died, so reacquiring it is right
          //   - well past the start -> the call is simply over (the extension also auto-stops
          //     after 10 min of silence), so this is terminal
          // Without the second case a finished call was re-recorded every poll for the rest of
          // the retry window, duplicating transcripts and leaking a tab per attempt.
          if (minsLeft > -reacquireGraceMinutes) {
            // Deliberately NOT removing the record: claim() derives the next attempt number
            // from the existing one, so removing first would pin attempts at 1 and make the
            // cap below unreachable - the same defect that let the retry path run ~200 times.
            if (record.attempts >= Number(config.maxAttempts ?? 4)) {
              store.markCompleted(key, `gave up reacquiring after ${record.attempts} attempts`);
              callTabs.closeFor(key, 'reacquire attempts exhausted');
              logger.warn(
                `Giving up on ${row.symbol} ${row.fiscalPeriod}: stream keeps disappearing after ` +
                  `${record.attempts} attempts.`
              );
              continue;
            }
            logger.info(
              `No active transcription for ${row.symbol} ${row.fiscalPeriod} and only ` +
                `${Math.abs(minsLeft).toFixed(0)} min past start; reacquiring (attempt ${record.attempts + 1}).`
            );
          } else {
            // `completed` is terminal AND closes the tab, so a single false negative would
            // destroy a capture that is still running - and the storage list this is based on
            // is known to be unreliable (an extension reload or service-worker restart can
            // clear it mid-call). Require the stream to be absent on consecutive polls before
            // acting, so one bad reading cannot end a live recording.
            const absences = (store.get(key)?.absentObservations || 0) + 1;
            const needed = Number(config.absentObservationsBeforeComplete ?? 2);
            if (absences < needed) {
              store.noteAbsent(key, absences);
              logger.info(
                `${row.symbol} ${row.fiscalPeriod}: stream not listed (${absences}/${needed}); ` +
                  'waiting for confirmation before treating the call as finished.'
              );
              continue;
            }
            store.markCompleted(key, `stream absent on ${absences} consecutive polls past the reacquire grace period`);
            callTabs.closeFor(key, 'call finished');
            logger.info(`${row.symbol} ${row.fiscalPeriod} finished (stream ended); marked complete.`);
            continue;
          }
        } else if (!store.retryDue(key) || record.attempts >= Number(config.maxAttempts ?? 4)) {
          continue;
        }
        // Deliberately NOT removing the record on the retry path: claim() derives the next
        // attempt number from the existing one, so deleting first pinned attempts at 1 - which
        // silently disabled maxAttempts and kept the backoff at its base delay forever.
      }
      store.claim(key); // claim immediately so the next poll does not double-process
      dispatchedThisPoll.add(key);
      batch.push({ row, key, minsLeft });
    }

    if (batch.length) {
      // Intentionally not awaited, so poll() keeps scanning for newly-due rows - but it MUST
      // have a rejection handler: a throw escaping the batch's own handling (e.g. writeFileSync
      // on a state file locked by an antivirus scanner) otherwise produced no log line, no
      // outcome record and no exit, and the calls simply vanished.
      runBatch(context, portalPage, batch, store, logger, obs, callTabs).catch((err) => {
        logger.error(`Batch failed outside its own handler: ${err && err.stack ? err.stack : err}`);
      });
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

  // Both of these are unbounded otherwise, which only matters for a process meant to run for
  // weeks: dedupe records were never removed (the file and Map grew forever), and the
  // warned-about set is keyed partly on the countdown text, so a row whose text ticks every
  // poll adds a new entry each time.
  const sweepState = () => {
    const removed = store.pruneExpired();
    if (removed) logger.info(`Pruned ${removed} dedupe record(s) past their TTL.`);
    if (warnedUnparseable.size > 5000) {
      warnedUnparseable.clear();
      logger.info('Cleared the unparseable-row warning set after it grew large; a warning may repeat once.');
    }
  };
  setInterval(sweepState, LOG_PRUNE_INTERVAL_MS);
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
    releaseInstanceLock(DATA_DIR);
    // Print the day's tally on the way out so stopping the watcher leaves a checkable record
    // rather than an impression. Read back from the ledger, so it is correct across restarts.
    try {
      const summary = createObservability(DATA_DIR, fatalLogger).summarize();
      fatalLogger.info(
        `Summary for ${summary.date} (the whole day, including earlier runs): ` +
          `started=${summary.started.length}, ` +
          `failed=${summary.failed.length}, skipped-late=${summary.skippedLate.length}, ` +
          `recovered-on-retry=${summary.retriedThenStarted.length}`
      );
      const late = summary.started.filter((s) => (s.lateBySec ?? 0) > 60);
      for (const s of late) fatalLogger.info(`  LATE    ${s.label} started ${s.lateBySec}s after the scheduled time`);
      // The per-call failure lines come from the reconciliation below rather than being printed
      // here as well. Both blocks were listing the same calls, so every stop printed each
      // problem twice - and the two disagreed, because this one counted attempts and that one
      // counts calls. Reconciliation is the wider of the two (it also covers calls that never
      // produced a ledger entry at all), so it is the one that reports the detail.
      for (const line of formatReconciliation(reconcile(DATA_DIR))) fatalLogger.info(line);
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
