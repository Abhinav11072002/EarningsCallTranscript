// Decides whether the page in front of us is really the call we are about to record.
//
// This exists as a pure function, separate from the browser work, because it got the answer
// wrong on 7 of 26 live captures and the only way to be sure it is right is to test it against
// what actually happened. The real page titles from that run are in the test suite.
//
// What those 7 had in common is the thing this now turns on: NO AUDIO. Five were registration
// pages ("Diamond Pass Registration", "Conference Registration", "Event Registration") and two
// were company homepages ("Movado Group, Inc. Corporate Website Homepage", "Home"). Every one
// recorded twenty minutes of silence and reported success, which is worse than failing.
//
// Chorus Call's Diamond Pass is the clearest case. Registering succeeds, and what it hands back
// is a telephone number and a PIN - there is no browser stream at all. No amount of waiting or
// clicking will make that tab produce audio, so recording it can only ever produce nothing.
//
// Hence the rule: a page must show something that can PLAY before it is worth capturing. That
// single requirement separates all 19 real captures from all 7 empty ones.

// Titles that say plainly we are not in a call. Cheap, and independent of the player check.
const NOT_A_CALL_TITLE_PATTERN =
  /^\s*(home|homepage|welcome)\s*$|corporate website|registration$|^registration|register now|sign\s*up|create an account/i;

// Escaped for use inside a word-boundary regex built at runtime.
function escapeForRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A ticker must appear as a WORD, not as a substring. "LI" matched inside "public", "listen"
// and "quality", so a two-letter ticker made almost any page look like the right one - which is
// how LI 2026Q2 came to record a "Diamond Pass Registration" page.
//
// Short tickers are additionally not trusted on their own: even as a whole word, "LI" or "DY"
// turns up in ordinary prose often enough that it is not evidence by itself.
const MIN_TRUSTWORTHY_SYMBOL_LENGTH = 3;

// A title that says what the page IS. Companies do not agree on fiscal notation - the portal
// called PLAB's call 2026Q3 while its page said "Photronics Q2 - FY26 Earnings", so neither the
// year nor the quarter matched and the ticker was nowhere in sight. A player plus a title that
// plainly announces an earnings event is better evidence than a quarter string anyway.
//
// This is only ever consulted AFTER the not-a-call titles are rejected, so "Conference
// Registration" cannot slip in on the word "conference".
const CALL_TITLE_PATTERN =
  /earnings|webcast|audiocast|conference call|results call|investor (?:call|day|update)|analyst (?:call|day)|quarter|interim results|full[- ]year results|half[- ]year|annual results|financial results/i;

function symbolAppearsAsWord(haystack, symbolRoot) {
  if (!symbolRoot || symbolRoot.length < 2) return false;
  return new RegExp(`\\b${escapeForRegex(symbolRoot)}\\b`, 'i').test(haystack);
}

// `hasPlayer` is supplied by the caller after inspecting the DOM - see playerProbe() below for
// what counts. Keeping the decision here and the DOM work there is what makes this testable.
function judgeRelevance({
  title = '',
  url = '',
  text = '',
  hasPlayer = false,
  symbol = '',
  year = '',
  period = '',
  dialinUrl = '',
}) {
  const haystack = `${title} ${url} ${text}`.toLowerCase();
  const symbolRoot = String(symbol || '')
    .split(/[.\-^]/)[0]
    .toLowerCase();

  if (NOT_A_CALL_TITLE_PATTERN.test(title.trim())) {
    return { accepted: false, reason: `the page is titled "${title.trim()}", which is not a call` };
  }

  // The load-bearing check. Without something that can play, there is nothing to capture, and
  // every second recorded is silence that looks exactly like a successful transcript.
  if (!hasPlayer) {
    return {
      accepted: false,
      reason:
        'the page has no audio or video player, so there is nothing to capture. Either the ' +
        'call was never joined, or this provider only offers a telephone dial-in',
    };
  }

  const strongSymbol =
    symbolRoot.length >= MIN_TRUSTWORTHY_SYMBOL_LENGTH && symbolAppearsAsWord(haystack, symbolRoot);
  const yearMatch = Boolean(year && haystack.includes(String(year).toLowerCase()));
  const periodMatch = Boolean(period && haystack.includes(String(period).toLowerCase()));

  let sameHostAsDialin = false;
  try {
    if (dialinUrl) sameHostAsDialin = new URL(url).hostname === new URL(dialinUrl).hostname;
  } catch {
    sameHostAsDialin = false;
  }

  // With a player confirmed, any of these is enough to believe it is the right call. They are
  // ordered by how much they actually tell us, so the log names the strongest one that applied.
  if (strongSymbol) return { accepted: true, reason: `a player, and the ticker "${symbolRoot}" as a word` };
  if (yearMatch && periodMatch) return { accepted: true, reason: `a player, and ${period} ${year}` };
  if (yearMatch || periodMatch) {
    return { accepted: true, reason: `a player, and ${periodMatch ? period : year}` };
  }
  if (CALL_TITLE_PATTERN.test(title)) {
    return { accepted: true, reason: `a player, and a title that announces an earnings event` };
  }
  if (sameHostAsDialin) {
    return { accepted: true, reason: `a player on the host the portal's own link pointed at` };
  }

  return {
    accepted: false,
    reason:
      'the page has a player but nothing tying it to this call - no ticker, no quarter, and a ' +
      'different host from the dial-in link, so resolution probably landed somewhere else',
  };
}

// Runs in the page. Deliberately stricter than the check it replaces, which counted ANY iframe
// as a player - and since nearly every page carries an iframe somewhere, that made the player
// requirement no requirement at all.
function playerProbe() {
  return {
    title: document.title || '',
    url: location.href,
    text: (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 4000),
    hasPlayer: (() => {
      // A real media element settles it immediately.
      if (document.querySelector('audio, video')) return true;
      // Otherwise look for an embedded player: something both named like one and big enough to
      // be one. Size alone would match a cookie banner; a name alone matches hidden markup.
      const candidates = document.querySelectorAll(
        'iframe, object, embed, [class*="player" i], [id*="player" i], [class*="webcast" i], [class*="stream" i]'
      );
      for (const el of candidates) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 200 || rect.height < 100) continue;
        const hint = `${el.getAttribute('src') || ''} ${el.className || ''} ${el.id || ''}`.toLowerCase();
        if (/player|webcast|stream|embed|broadcast|meeting|media|video|audio|live/.test(hint)) return true;
      }
      return false;
    })(),
  };
}

module.exports = { judgeRelevance, playerProbe, NOT_A_CALL_TITLE_PATTERN, CALL_TITLE_PATTERN, symbolAppearsAsWord };
