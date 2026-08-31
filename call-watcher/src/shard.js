// Which machine owns a call, when more than one machine is watching the same table.
//
// THE PROPERTY THAT MATTERS: the answer depends only on the call itself, never on its position
// in the current list. That is what makes coverage exactly-once with no coordination between
// machines - no shared database, no leases, no clock sync.
//
// Interleaving by position - machine A takes the 1st, 3rd, 5th row - looks like the obvious
// answer and is the one scheme that can BOTH double-record and miss. Positions shift as calls
// leave the window and as the portal fills in a link mid-morning, so a call that was 3rd becomes
// 2nd, changes owner, and is either recorded twice or by nobody. Nothing here may depend on the
// shape of the list.
//
// The rule is a sum of character codes rather than a real hash so that it stays checkable by
// hand: given a call, anyone can work out which machine should take it, and
// `npm run shard-preview` prints the whole book with its owners before a single call runs.

// The whole rule. Deliberately not a real hash: a sum of character codes stays checkable by
// hand, so anyone can work out which machine owns a call with a calculator.
function charSum(value) {
  let total = 0;
  const text = String(value || '');
  for (let i = 0; i < text.length; i++) total += text.charCodeAt(i);
  return total;
}

// What identifies the EVENT rather than the row.
//
// A dual listing is the same webcast under two symbols - 601939.SS and CICHY, CM and CM.TO,
// ECOR.L and ECOR.TO - carrying the same dial-in link at the same time. Keying on the link puts
// both rows on one machine, so one browser opens that page instead of two opening it at once.
// Falling back to the symbol keeps a row with no link usable rather than lumping every such row
// onto machine 0.
function shardKeyFor(row) {
  const link = String(row.dialinLink || '').trim();
  if (link && link !== '-') return link;
  return `${row.symbol || ''}|${row.fiscalPeriod || ''}`;
}

// The owning machine index, 0-based. Always 0 when sharding is off, so a single machine keeps
// every call and nothing changes for an existing install.
// NOTHING derived from the clock may appear here.
//
// The first version added the call's scheduled minute, to spread a same-minute burst. That
// minute is RECONSTRUCTED from the portal's countdown text plus the current time, so two
// machines polling a second apart land on different minutes - 659 against 660 - and every
// owner flips. Both machines would then have recorded the other's entire share. Caught by
// running shard-preview on both machines and comparing, which is why that command exists.
//
// The link alone is enough to spread a burst anyway: calls in the same minute are different
// events with different links, so their sums differ.
function shardIndexFor(row, count) {
  const machines = Number(count) || 1;
  if (machines <= 1) return 0;
  return charSum(shardKeyFor(row)) % machines;
}

// Does this machine own the call?
function ownsRow(row, shard) {
  const count = Number(shard && shard.count) || 1;
  if (count <= 1) return true;
  return shardIndexFor(row, count) === (Number(shard && shard.index) || 0);
}

// Read and sanity-check the shard settings. A misconfigured pair of machines is the one mistake
// that silently drops calls, so this refuses rather than guesses.
function readShard(config) {
  const raw = (config && config.shard) || {};
  const count = Number(raw.count ?? 1);
  const index = Number(raw.index ?? 0);

  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`shard.count must be a whole number of 1 or more (got ${JSON.stringify(raw.count)})`);
  }
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new Error(
      `shard.index must be between 0 and ${count - 1} for shard.count ${count} (got ${JSON.stringify(raw.index)})`
    );
  }
  return { index, count };
}

function describeShard(shard) {
  if (shard.count <= 1) return 'Sharding off: this machine takes every call.';
  return `Shard ${shard.index + 1} of ${shard.count}: this machine takes the calls assigned to index ${shard.index}.`;
}

module.exports = { shardIndexFor, ownsRow, readShard, describeShard, shardKeyFor, charSum };
