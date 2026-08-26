// Turns the outcome ledger into a ranked work list.
//
// `npm run report` answers "did we get everything today?". This answers the next question:
// "what keeps going wrong, and which fix would buy the most calls back?"
//
// It exists because the failures worth fixing are the REPEATED ones, and a day's log does not
// show repetition - each failure appears once, in its own words, scattered among hundreds of
// routine lines. Five calls lost to the same unfilled form field look like five unrelated
// problems until they are counted together.
//
// Two things it reports that nothing else does:
//
//   Captures at risk - calls recorded with no audio playing. These are the dangerous ones: a
//   silent capture is indistinguishable from a good one in every other field, so it is counted
//   as a success and nobody looks again.
//
//   Failures by provider - which platforms cost the most calls. A cause that appears once is a
//   curiosity; the same cause on the same platform five times is where the next hour of work
//   belongs.
//
// Usage:
//   npm run analyze              today
//   npm run analyze -- --all     every day on disk
//   npm run analyze -- 2026-08-26
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

// Error text carries the specifics of one call - a title, a URL, a field name. Grouping needs
// the shape of the problem, not its details, so each known failure is reduced to a cause and a
// suggested action. Anything unrecognised is grouped by its first few words rather than
// silently dropped, so a NEW recurring failure surfaces on its own.
const CAUSES = [
  {
    match: /Registration gate still appears active/i,
    cause: 'Registration form could not be completed',
    action: 'Run: node scripts/diagnostics/diag-form-fields.js <url> - it shows which field is left empty',
  },
  {
    match: /no audio or video player/i,
    cause: 'Page had no player (never joined, or telephone-only)',
    action: 'Check whether the provider offers a browser stream at all; Chorus Call Diamond Pass does not',
  },
  {
    match: /is titled .*which is not a call/i,
    cause: 'Still on a registration or home page when the capture was due',
    action: 'Same as a failed registration - the form was not completed in time',
  },
  {
    match: /does not identifiably belong|landed on the wrong page/i,
    cause: 'Resolution landed on the wrong page',
    action: 'Check the dial-in link by hand; the provider may need adding to knownDirectProviderDomains',
  },
  {
    match: /not inside the call yet/i,
    cause: 'A join screen was still in the way',
    action: 'The wording may need adding to BROWSER_ENTRY_PATTERN or ENTRY_BUTTON_PATTERN in joinFlow.js',
  },
  {
    match: /CAPTCHA|anti-bot/i,
    cause: 'CAPTCHA - cannot be solved automatically',
    action: 'These need a human. Consider registering once by hand if the provider remembers the session',
  },
  {
    match: /Timed out waiting for the extension popup|Focus\/keystroke injection failed/i,
    cause: 'The extension popup did not open',
    action: 'Check Accessibility permission and that the shortcut scope is "In Chrome"',
  },
  {
    match: /could not confirm an active stream/i,
    cause: 'Capture started but could not be confirmed',
    action: 'Usually harmless now - the extension stream list is consulted as a fallback',
  },
  {
    match: /call is over or unavailable|replay\/archive/i,
    cause: 'The call had already ended',
    action: 'Dispatched too late - check whether the portal published the link in time',
  },
  {
    match: /exceeded the .* limit|timed out/i,
    cause: 'A step ran out of time',
    action: 'Look for a slow provider page; prepareDeadlineMs and triggerDeadlineMs bound this',
  },
  {
    match: /Refusing to record/i,
    cause: 'Refused for another reason',
    action: 'Read the full message in the log - the guard names what it objected to',
  },
];

function classify(error) {
  const text = String(error || '');
  for (const entry of CAUSES) {
    if (entry.match.test(text)) return entry;
  }
  // Unrecognised: group by the opening words so a new recurring failure still clusters.
  const gist = text.split(/[:(]/)[0].trim().slice(0, 60) || 'Unknown';
  return { cause: gist, action: 'Not yet recognised - if this recurs it is worth a rule of its own' };
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function readLedger(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a half-written final line must not lose the day */
    }
  }
  return out;
}

function ledgerFiles(arg) {
  const all = fs
    .readdirSync(DATA_DIR)
    .filter((f) => /^outcomes-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .sort();
  if (arg === '--all') return all;
  if (/^\d{4}-\d{2}-\d{2}$/.test(arg || '')) return all.filter((f) => f.includes(arg));
  const today = new Date();
  const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return all.filter((f) => f.includes(stamp));
}

function bar(n, max, width = 24) {
  return '█'.repeat(Math.max(1, Math.round((n / Math.max(max, 1)) * width)));
}

const files = ledgerFiles(process.argv[2]);
if (!files.length) {
  console.log('No ledger files for that date. Try: npm run analyze -- --all');
  process.exit(0);
}

const entries = files.flatMap((f) => readLedger(path.join(DATA_DIR, f)));
const byCall = new Map();
for (const e of entries) {
  const label = `${e.symbol} ${e.fiscalPeriod}`;
  if (!byCall.has(label)) byCall.set(label, []);
  byCall.get(label).push(e);
}

const recorded = [];
const failed = [];
const atRisk = [];
let totalAttempts = 0;

for (const [label, attempts] of byCall) {
  totalAttempts += attempts.length;
  const started = attempts.find((a) => a.status === 'started');
  if (started) {
    recorded.push({ label, entry: started, attempts: attempts.length });
    // The dangerous shape: counted as success, produced nothing.
    if (started.audioPlaying === false) {
      atRisk.push({
        label,
        why: 'no audio was playing when the capture began',
        title: started.pageTitle,
        // Negative secondsLate means the call had not started yet, which explains silence.
        early: typeof started.secondsLateVsScheduled === 'number' ? Math.round(-started.secondsLateVsScheduled / 60) : null,
      });
    }
    continue;
  }
  const last = attempts.filter((a) => a.status === 'failed').pop();
  if (last) failed.push({ label, entry: last, attempts: attempts.filter((a) => a.status === 'failed').length });
}

console.log('');
console.log(`Deep analysis of ${files.length} day(s): ${files[0].slice(9, 19)}${files.length > 1 ? ` to ${files[files.length - 1].slice(9, 19)}` : ''}`);
console.log('='.repeat(78));
console.log(`  calls attempted   ${byCall.size}`);
console.log(`  recorded          ${recorded.length}`);
console.log(`  failed            ${failed.length}`);
console.log(`  ledger entries    ${totalAttempts}  (attempts, including retries)`);

// ---------------------------------------------------------------- captures at risk
console.log('');
console.log('CAPTURES AT RISK - counted as successes, but probably silent');
console.log('-'.repeat(78));
if (!atRisk.length) {
  console.log('  none - every capture had audio playing when it began');
} else {
  for (const r of atRisk) {
    const early = r.early === null ? '' : r.early > 0 ? `  (joined ${r.early} min BEFORE the scheduled start)` : '  (joined after the start)';
    console.log(`  ${r.label.padEnd(18)} ${r.why}${early}`);
    console.log(`  ${''.padEnd(18)} title: ${JSON.stringify(r.title || '')}`);
  }
  console.log('');
  console.log('  A capture that began before the call did will legitimately be silent at first -');
  console.log('  those are only a worry because the extension stops a stream after ten minutes of');
  console.log('  silence, which the poll loop then reads as the call having died. One that began');
  console.log('  AFTER the scheduled start and is still silent is the more serious shape.');
}

// ---------------------------------------------------------------- failures by cause
const causeGroups = new Map();
for (const f of failed) {
  const { cause, action } = classify(f.entry.error);
  if (!causeGroups.has(cause)) causeGroups.set(cause, { calls: [], action });
  causeGroups.get(cause).calls.push(f.label);
}
const rankedCauses = [...causeGroups.entries()].sort((a, b) => b[1].calls.length - a[1].calls.length);

console.log('');
console.log('WHY CALLS WERE LOST - ranked by how many that cause cost');
console.log('-'.repeat(78));
if (!rankedCauses.length) {
  console.log('  nothing failed');
} else {
  const worst = rankedCauses[0][1].calls.length;
  for (const [cause, group] of rankedCauses) {
    console.log(`  ${String(group.calls.length).padStart(3)}  ${bar(group.calls.length, worst)}  ${cause}`);
    console.log(`       ${group.calls.join(', ')}`);
    console.log(`       -> ${group.action}`);
    console.log('');
  }
}

// ---------------------------------------------------------------- failures by provider
const providerGroups = new Map();
for (const f of failed) {
  const host = hostOf(f.entry.resolvedUrl) || hostOf(f.entry.dialinUrl) || 'unknown';
  providerGroups.set(host, (providerGroups.get(host) || 0) + 1);
}
const rankedProviders = [...providerGroups.entries()].sort((a, b) => b[1] - a[1]);

console.log('WHICH PLATFORMS COST THE MOST');
console.log('-'.repeat(78));
if (!rankedProviders.length) {
  console.log('  nothing failed');
} else {
  const worst = rankedProviders[0][1];
  for (const [host, count] of rankedProviders) {
    console.log(`  ${String(count).padStart(3)}  ${bar(count, worst)}  ${host}`);
    // The URL of one failing call on that platform, so the next step is a copy and paste rather
    // than a hunt through the ledger. Diagnosing the platform is what fixes all of its calls.
    const example = failed.find(
      (f) => (hostOf(f.entry.resolvedUrl) || hostOf(f.entry.dialinUrl)) === host && (f.entry.resolvedUrl || f.entry.dialinUrl)
    );
    if (example) console.log(`       e.g. ${example.entry.resolvedUrl || example.entry.dialinUrl}`);
  }
  console.log('');
  console.log('  A cause seen once is a curiosity. The same platform failing repeatedly is');
  console.log('  where the next hour of work belongs.');
}

// ---------------------------------------------------------------- retries
const needed = recorded.filter((r) => r.attempts > 1);
const exhausted = failed.filter((f) => f.attempts >= 4);
console.log('');
console.log('RETRIES');
console.log('-'.repeat(78));
console.log(`  recorded only after a retry   ${needed.length}${needed.length ? '  (' + needed.map((r) => r.label).join(', ') + ')' : ''}`);
console.log(`  used every attempt and failed ${exhausted.length}${exhausted.length ? '  (' + exhausted.map((f) => f.label).join(', ') + ')' : ''}`);
if (exhausted.length) {
  console.log('');
  console.log('  Each attempt searches wider than the last, so a call that exhausts all four');
  console.log('  is not being missed for want of trying - the cause above is the thing to fix.');
}
console.log('');
