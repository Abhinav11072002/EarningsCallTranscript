const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

const args = process.argv.slice(2);
const dateFlag = args.find((a) => a.startsWith('--date='));
const [symbol, fiscalPeriod] = args.filter((a) => !a.startsWith('--'));

function dayStamp(now = new Date()) {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

const day = dateFlag ? dateFlag.slice('--date='.length) : dayStamp();

if (!symbol || !fiscalPeriod || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
  console.error('Usage: node scripts/mark-recorded.js <SYMBOL> <FISCALPERIOD> [--date=YYYY-MM-DD]');
  console.error('   e.g. node scripts/mark-recorded.js LND 2027Q1');
  process.exit(1);
}

const file = path.join(DATA_DIR, `outcomes-${day}.jsonl`);

let existing = [];
try {
  existing = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
} catch {
  console.error(`No ledger for ${day} (${file}).`);
  console.error('This machine may not be the one that owns that call - check the other machine.');
  process.exit(1);
}

const mine = existing.filter((e) => e.symbol === symbol && e.fiscalPeriod === fiscalPeriod);

if (!mine.length) {
  console.error(`${symbol} ${fiscalPeriod} does not appear in ${day}'s ledger on this machine.`);
  console.error('Either the call belongs to the other machine, or the watcher never saw it.');
  process.exit(1);
}

const already = mine.find((e) => e.status === 'started');
if (already) {
  console.log(`${symbol} ${fiscalPeriod} is already recorded as started at ${already.ts.slice(11, 19)}` +
    (already.startedBy ? ` (by ${already.startedBy})` : '') + '. Nothing to do.');
  process.exit(0);
}

const last = mine[mine.length - 1];
const entry = {
  ts: new Date().toISOString(),
  status: 'started',
  symbol,
  fiscalPeriod,
  earningsDate: last.earningsDate,
  dialinUrl: last.dialinUrl || null,
  startedBy: 'operator',
  note: 'recorded by hand; asserted after the fact',
  attempts: last.attempts ?? null,
};

fs.appendFileSync(file, JSON.stringify(entry) + '\n');

console.log(`Marked ${symbol} ${fiscalPeriod} as recorded by hand in ${path.basename(file)}.`);
console.log(`  it had ${mine.length} failed attempt(s), last: ${String(last.error || '').slice(0, 90)}`);
console.log('  the ledger is append-only, so the failures remain visible alongside this.');
console.log('  reload the dashboard to see it.');
