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

// Calls cluster on the hour and the half hour, so the minute alone would put a whole burst on
// one machine. Mixing in the identity spreads a same-minute cluster across the machines while
// keeping the answer fixed per call.
function charSum(value) {
  let total = 0;
  const text = String(value || '');
  for (let i = 0; i < text.length; i++) total += text.charCodeAt(i);
  return total;
}

// Local minutes since midnight for the call's scheduled time, or null when it has none.
//
// Local, deliberately: every machine watching this table is in the same office and the same
// timezone, and a local figure is the one a person can check against the portal's own column.
function scheduledMinute(row) {
  if (typeof row.dueAt === 'number' && Number.isFinite(row.dueAt)) {
    const when = new Date(row.dueAt);
    return when.getHours() * 60 + when.getMinutes();
  }
  return null;
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
function shardIndexFor(row, count) {
  const machines = Number(count) || 1;
  if (machines <= 1) return 0;
  const minute = scheduledMinute(row);
  // A row with no scheduled time is never dispatched anyway - it cannot be judged against the
  // 15-minute window - so where it lands does not matter. Keeping it deterministic avoids two
  // machines disagreeing about it in a log.
  const base = minute === null ? 0 : minute;
  return (base + charSum(shardKeyFor(row))) % machines;
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

module.exports = { shardIndexFor, ownsRow, readShard, describeShard, shardKeyFor, scheduledMinute, charSum };
