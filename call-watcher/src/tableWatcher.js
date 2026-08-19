// The portal's table isn't a real HTML <table> - it's a custom div grid with hashed
// CSS-module class names (e.g. "global_frcc__B62An") that can change on every deploy, and
// cells are positioned individually rather than nested in row/column DOM structure. So
// instead of matching markup, we match GEOMETRY: find each header label by its exact
// visible text, record its on-screen X position, then reconstruct rows by finding cell
// elements whose X lines up with a known column and whose Y lines up with each other.
// This survives class-name/markup churn as long as the visible column labels don't change.
const COLUMN_LABELS = ['Earnings Date', 'Symbol', 'Fiscal Period', 'Transcription Time', 'Dialin Link'];
const POSITION_TOLERANCE_PX = 6;

async function extractRows(page) {
  return page.evaluate(
    ({ columnLabels, tol }) => {
      // Cells aren't guaranteed to be true DOM leaves - e.g. the countdown is rendered as
      // <p><span>3 hrs </span><span>17 min </span><span>19 sec </span></p>. The <p> already
      // carries the full concatenated text, so <span> fragments are excluded here entirely:
      // otherwise a lone "3 hrs" fragment can end up positioned close enough to a neighboring
      // column (e.g. Fiscal Period) to get mismatched as that column's value.
      const all = Array.from(document.querySelectorAll('body *:not(span)'))
        .map((el) => {
          // Collapse all whitespace (including non-breaking spaces, which JS's \s matches)
          // so a label rendered with an nbsp still compares equal to a plain-space string.
          const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (!text) return null;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return null;
          return { el, top: r.top, left: r.left, area: r.width * r.height, text };
        })
        .filter(Boolean);

      function findAt(top, left) {
        const candidates = all.filter((e) => Math.abs(e.top - top) <= tol && Math.abs(e.left - left) <= tol);
        if (!candidates.length) return null;
        candidates.sort((a, b) => a.area - b.area);
        return candidates[0];
      }

      // Some cells (e.g. a long left-aligned link vs. a short centered label) don't sit at
      // the exact same X as the header. Fall back to "closest element on this row" within a
      // generous band, rather than requiring pixel-exact alignment.
      const NEAREST_MAX_DIST = 150;
      function findNearestOnRow(rowTop, targetLeft) {
        const rowCandidates = all.filter((e) => Math.abs(e.top - rowTop) <= tol);
        if (!rowCandidates.length) return null;
        rowCandidates.sort((a, b) => {
          const da = Math.abs(a.left - targetLeft);
          const db = Math.abs(b.left - targetLeft);
          return da - db || a.area - b.area;
        });
        const best = rowCandidates[0];
        return Math.abs(best.left - targetLeft) <= NEAREST_MAX_DIST ? best : null;
      }

      // Dedupe same-position matches (a leaf and its tight wrapper both "match" a label) by
      // keeping only the smallest-area element per rounded position bucket.
      function dedupeByPosition(items) {
        const sorted = [...items].sort((a, b) => a.area - b.area);
        const seen = new Set();
        const out = [];
        for (const it of sorted) {
          const key = `${Math.round(it.top / tol)}:${Math.round(it.left / tol)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(it);
        }
        return out;
      }

      const headerHits = {};
      for (const label of columnLabels) {
        headerHits[label] = dedupeByPosition(all.filter((e) => e.text === label));
      }
      if (!headerHits['Symbol'].length) return [];

      const results = [];
      const symbolHeaderTops = headerHits['Symbol'].map((h) => h.top).sort((a, b) => a - b);

      for (const symbolHeader of headerHits['Symbol']) {
        const headerTop = symbolHeader.top;
        const colX = { Symbol: symbolHeader.left };
        for (const label of columnLabels) {
          if (label === 'Symbol') continue;
          const match = headerHits[label].find((e) => Math.abs(e.top - headerTop) <= tol);
          colX[label] = match ? match.left : null;
        }

        // This date-group's rows live between its own header and the next date-group's
        // header (or the end of the page if this is the last one).
        const bandEnd = symbolHeaderTops.find((t) => t > headerTop + tol) ?? Infinity;

        const symbolCells = dedupeByPosition(
          all.filter((e) => Math.abs(e.left - colX.Symbol) <= tol && e.top > headerTop + tol && e.top < bandEnd)
        );

        for (const cell of symbolCells) {
          const rowTop = cell.top;
          const getVal = (label) => {
            if (colX[label] == null) return null;
            const found = findAt(rowTop, colX[label]) || findNearestOnRow(rowTop, colX[label]);
            if (!found) return null;
            // The Dialin Link cell isn't a real <a> - it's styled plain text
            // (<p class="style_linkText__...">https://...</p>). Treat the visible text
            // itself as the URL when it looks like one; "-" (no link yet) has no href.
            const href = label === 'Dialin Link' && /^https?:\/\//i.test(found.text) ? found.text : null;
            return { text: found.text, href };
          };

          // The portal sometimes appends a trailing "^" badge to certain symbols (seen
          // alongside its "Mismatch" data flag) - strip it so it never ends up written into
          // the transcript's Symbol field or the dedupe key as if it were part of the ticker.
          const symbol = cell.text.replace(/\^$/, '');
          if (!symbol) continue;

          const earningsDate = getVal('Earnings Date');
          const fiscalPeriod = getVal('Fiscal Period');
          const transcriptionTime = getVal('Transcription Time');
          const dialinLink = getVal('Dialin Link');

          results.push({
            earningsDate: earningsDate ? earningsDate.text : '',
            symbol,
            fiscalPeriod: fiscalPeriod ? fiscalPeriod.text : '',
            transcriptionTimeText: transcriptionTime ? transcriptionTime.text : '',
            transcriptionTimeEpoch: null,
            dialinLink: dialinLink ? dialinLink.href : null,
          });
        }
      }

      return results;
    },
    { columnLabels: COLUMN_LABELS, tol: POSITION_TOLERANCE_PX }
  );
}

function parseCountdownToMinutes(text) {
  if (!text) return null;
  const days = /(-?\d+(?:\.\d+)?)\s*days?/i.exec(text);
  const hrs = /(-?\d+(?:\.\d+)?)\s*hrs?/i.exec(text);
  const min = /(-?\d+(?:\.\d+)?)\s*min/i.exec(text);
  const sec = /(-?\d+(?:\.\d+)?)\s*sec/i.exec(text);
  if (!days && !hrs && !min && !sec) return null;
  const d = days ? parseFloat(days[1]) : 0;
  const h = hrs ? parseFloat(hrs[1]) : 0;
  const m = min ? parseFloat(min[1]) : 0;
  const s = sec ? parseFloat(sec[1]) : 0;
  return d * 1440 + h * 60 + m + s / 60;
}

const MONTH_ABBR = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const ABSOLUTE_DATETIME_PATTERN = /^(\d{4})\s+([A-Za-z]{3})\s+(\d{1,2})\s*-\s*(\d{1,2}):(\d{2}):(\d{2})/;

// Determines America/New_York's current UTC offset (in minutes) for a given instant, via the
// ICU timezone database (Intl) - handles the EST/EDT switch automatically, unlike a hardcoded
// offset which would silently go an hour wrong every time DST changes.
function nyOffsetMinutes(date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = {};
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
  const asIfUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return (asIfUTC - date.getTime()) / 60000;
}

// The portal sometimes shows an absolute date-time instead of a live countdown - e.g.
// "2026 Aug 27 - 09:00:00 AM" - seemingly for calls further out or not yet on a live countdown.
// The hour is already 24-hour (values like "16:30:00 PM" appear), so the AM/PM suffix is
// ignored; the value is treated as America/New_York local time, matching the epoch-in-EST
// format used elsewhere in this table.
function parseAbsoluteDateTimeToMinutes(text) {
  const m = ABSOLUTE_DATETIME_PATTERN.exec((text || '').trim());
  if (!m) return null;
  const [, year, monthAbbr, day, hour, minute, second] = m;
  const month = MONTH_ABBR[monthAbbr.toLowerCase()];
  if (month === undefined) return null;

  const naiveUTC = Date.UTC(+year, month, +day, +hour, +minute, +second);
  const offsetMin = nyOffsetMinutes(new Date(naiveUTC));
  const actualUTCms = naiveUTC - offsetMin * 60000;
  return (actualUTCms - Date.now()) / 60000;
}

function minutesUntilCall(row) {
  if (row.transcriptionTimeEpoch) {
    const num = Number(row.transcriptionTimeEpoch);
    if (!Number.isNaN(num)) {
      const epochMs = num < 1e12 ? num * 1000 : num; // seconds vs ms epoch
      return (epochMs - Date.now()) / 60000;
    }
  }
  const countdown = parseCountdownToMinutes(row.transcriptionTimeText);
  if (countdown !== null) return countdown;
  return parseAbsoluteDateTimeToMinutes(row.transcriptionTimeText);
}

function rowKey(row) {
  return `${row.symbol}|${row.fiscalPeriod}|${row.earningsDate}`;
}

module.exports = { extractRows, minutesUntilCall, rowKey, parseCountdownToMinutes };
