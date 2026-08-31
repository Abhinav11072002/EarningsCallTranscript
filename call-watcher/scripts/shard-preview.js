// Shows which machine owns which call, before a single call runs.
//
// Sharding has no coordination between machines, which is what makes it safe - and also what
// makes it impossible to verify by watching one machine. This prints the whole book with its
// owners, so the split can be checked by eye and by arithmetic rather than trusted.
//
// It also prints the busiest 15-minute window per machine, which is the number that actually
// matters: preparation runs three at a time but the extension trigger is serial, so a machine's
// limit is calls-per-window, not calls-per-day.
//
// Usage:
//   node scripts/shard-preview.js            with the count from config.json
//   node scripts/shard-preview.js 2          pretend there are 2 machines
//   node scripts/shard-preview.js 2 --list   name every call and its owner
const { chromium } = require('playwright-core');
const { loadConfig } = require('../src/loadConfig');
const { extractRows, minutesUntilCall, stampDueAt } = require('../src/tableWatcher');
const { getOrOpenPortalPage } = require('../src/browserConnect');
const { shardIndexFor, readShard, shardKeyFor } = require('../src/shard');

const config = loadConfig();
const argCount = Number(process.argv.find((a) => /^\d+$/.test(a)) || 0);
const count = argCount || readShard(config).count;
const listAll = process.argv.includes('--list');

(async () => {
  const browser = await chromium.connectOverCDP(config.cdpUrl);
  const portal = await getOrOpenPortalPage(browser.contexts()[0], config.portalUrl);
  const rows = (await extractRows(portal)).filter((r) => r.dialinLink && r.dialinLink !== '-');
  await browser.close().catch(() => {});

  // Only calls still ahead of us can be affected by a split.
  const upcoming = [];
  for (const row of rows) {
    const mins = minutesUntilCall(row);
    if (mins === null || mins < -15) continue;
    upcoming.push(stampDueAt(row, mins));
  }
  upcoming.sort((a, b) => a.dueAt - b.dueAt);

  const stamp = (at) => new Date(at).toISOString().slice(0, 16).replace('T', ' ');
  const perMachine = Array.from({ length: count }, () => []);
  for (const row of upcoming) perMachine[shardIndexFor(row, count)].push(row);

  console.log('');
  console.log(`${upcoming.length} upcoming call(s) with a link, split across ${count} machine(s)`);
  console.log('='.repeat(78));

  if (listAll) {
    for (const row of upcoming) {
      const owner = shardIndexFor(row, count);
      console.log(
        `  ${stamp(row.dueAt)}  machine ${owner}  ${`${row.symbol} ${row.fiscalPeriod}`.padEnd(20)} ${shardKeyFor(row).slice(0, 34)}`
      );
    }
    console.log('-'.repeat(78));
  }

  // The number that decides how many machines are needed.
  const peakFor = (list) => {
    const windows = new Map();
    for (const row of list) {
      const key = Math.floor(row.dueAt / (15 * 60000));
      windows.set(key, (windows.get(key) || 0) + 1);
    }
    let peak = 0;
    let when = null;
    for (const [key, n] of windows) {
      if (n > peak) {
        peak = n;
        when = key * 15 * 60000;
      }
    }
    return { peak, when };
  };

  console.log('machine   calls   busiest 15-min window');
  console.log('-'.repeat(78));
  for (const [index, list] of perMachine.entries()) {
    const { peak, when } = peakFor(list);
    console.log(
      `  ${String(index).padEnd(7)} ${String(list.length).padStart(5)}   ` +
        (when ? `${peak} at ${stamp(when)}` : '-')
    );
  }
  const all = peakFor(upcoming);
  console.log('-'.repeat(78));
  console.log(`  unsplit  ${String(upcoming.length).padStart(5)}   ${all.when ? `${all.peak} at ${stamp(all.when)}` : '-'}`);
  console.log('');
  console.log('The busiest window is the number that matters: preparation runs three at a time but');
  console.log('the extension trigger is serial, so a machine is limited by calls per window rather');
  console.log('than calls per day. If the unsplit peak is comfortable, more machines buy nothing.');
  console.log('');
})().catch((err) => {
  console.error('shard preview failed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
