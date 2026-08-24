// Getting from a provider's landing page INTO the actual call, when what stands in the way is
// not a registration form but a choice of client.
//
// Why this exists (observed live, NSCIF 2026Q2 on 2026-08-24): the dial-in link resolved to
// https://us02web.zoom.us/j/83171321596?pwd=... - a known provider domain, so the resolver
// correctly stopped there. But that page is Zoom's lobby: a "Join meeting" heading over two
// buttons, "Join from Zoom Workplace app" and "Join from browser", and no input fields at all.
// formFiller.js looks for identity fields and registration-worded buttons; this page has
// neither, so it reported no gate and the pipeline went straight on to start transcription.
// The ledger recorded what that produced:
//
//   "pageTitle":"Join from Zoom Workplace app - Zoom","status":"started"
//
// An earnings call was "captured" from a lobby page that had never been joined.
//
// Two rules are non-negotiable here:
//
//  1. NEVER click the native-app option. It fires a zoommtg:// protocol handler, which raises
//     an OS-level "Open Zoom Workplace?" dialog. That dialog takes the foreground - and the
//     foreground is exactly what extensionTrigger.js needs in order to deliver the keystroke
//     that opens the extension popup. So clicking it does not merely fail to join, it breaks
//     the step after it as well. formFiller's generic CTA pattern matches the bare word "join",
//     so without an explicit exclusion that button is a live hazard on every Zoom call.
//
//  2. Prefer the page's own browser link over a URL we construct. Zoom's link carries tokens
//     and referrer state we cannot always reproduce; the constructed URL is the fallback for
//     when the link is absent (Zoom has historically hidden it behind a launch attempt).

// Anything that hands the call to a desktop application instead of this tab. Capture happens in
// the tab, so a native client is not "the call" - it is the end of the recording.
const NATIVE_APP_PATTERN =
  /workplace app|(?:open|launch|join|continue)\s+(?:in|from|with|the)?\s*(?:the\s+)?(?:desktop|native|zoom|teams|webex)?\s*app\b|launch meeting|download (?:now|the app|zoom)|install|get the app|open zoom/i;

// The browser-based way in. Ordered loosely by how explicit each phrasing is.
// The determiner set matters more than it looks: Microsoft Teams words this "Continue on THIS
// browser", and an earlier version listing only "the|your" missed it entirely - which is the
// same failure as Zoom's, on the second-most-common platform.
const DET = '(?:the |your |this )?';
const BROWSER_ENTRY_PATTERN = new RegExp(
  [
    `join from ${DET}browser`,
    `join (?:via|in|through|on) ${DET}browser`,
    `continue (?:in|on|with) ${DET}browser`,
    `watch (?:in|on|from) ${DET}browser`,
    `listen (?:in|on|via) ${DET}browser`,
    `use ${DET}web client`,
    `join (?:on|from) the web\b`,
    'browser version',
  ].join('|'),
  'i'
);

// Text that only appears while still OUTSIDE the call. Used by the relevance guard: if any of
// these is on screen at capture time, whatever we are about to record is not the call.
const PRE_JOIN_TEXT_PATTERN =
  /join from (?:your )?browser|join from (?:the )?zoom workplace app|enter meeting info|launch meeting|do(?:n'|n’|n)?t have the .{0,40}app installed/i;

// The call is over, or was cancelled. Recording this is not a near-miss - it is guaranteed
// silence billed as a successful capture, and it looks identical to a good run in the ledger.
// Kept strictly separate from the "waiting" wording below, which is the healthy pre-call state.
// Deliberately narrow. A false refusal loses a live call outright, so wording that can appear
// perfectly well BESIDE a running stream is excluded on purpose: "registration is closed" is
// routine on a player page once the call has begun, "thank you for attending" can be pre-set
// copy, and "a replay will be available" is a promise about later, not a statement about now.
// What is left only describes a call that is actually over.
const TERMINAL_STATE_PATTERN =
  /(?:meeting|webinar|webcast|event|conference|broadcast|call)\s+(?:has\s+)?(?:already\s+)?(?:ended|concluded|finished|expired|been cancell?ed|is over)|this (?:meeting|webinar|event) (?:has been |was )?cancell?ed|no longer (?:available|active)/i;

// Explicitly NOT a blocker. These mean we are correctly parked in the right place and the audio
// is about to start - refusing here would fail every call that we join a few minutes early,
// which is the whole point of the 15-minute window.
const LEGITIMATE_WAIT_PATTERN =
  /waiting for the host|host will let you in|will begin (?:shortly|soon)|has not (?:yet )?started|starts in|please wait|waiting room|standing by|hold music/i;

// See formFiller.js's POPUP_GRACE_MS - a click's popup fires immediately, and this wait is
// paid on every click that opens nothing.
const POPUP_GRACE_MS = 600;

const MAX_JOIN_STEPS = 4;
const CTA_TEXT_LIMIT = 80; // a real entry CTA is short; long text is prose that mentions one

// https://us02web.zoom.us/j/83171321596?pwd=ABC  ->  https://app.zoom.us/wc/83171321596/join?pwd=ABC
// Deliberately narrow: only zoom.us hosts, only /j/ (meeting) and /w/ (webinar) paths, only a
// numeric meeting id. Anything else returns null rather than guessing at a URL shape.
function zoomWebClientUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== 'zoom.us' && !host.endsWith('.zoom.us')) return null;
  // Already on the web client - nothing to transform, and returning a URL here would loop.
  if (host === 'app.zoom.us') return null;
  const match = parsed.pathname.match(/^\/(?:j|w)\/(\d{6,})\/?$/);
  if (!match) return null;
  const target = new URL(`https://app.zoom.us/wc/${match[1]}/join`);
  const pwd = parsed.searchParams.get('pwd');
  if (pwd) target.searchParams.set('pwd', pwd);
  return target.toString();
}

async function visibleClickables(page) {
  const out = [];
  for (const frame of page.frames()) {
    const els = await frame
      .$$('a:visible, button:visible, [role=button]:visible, input[type=button]:visible')
      .catch(() => []);
    for (const el of els) {
      const text = (
        (await el.innerText().catch(() => '')) ||
        (await el.getAttribute('value').catch(() => '')) ||
        ''
      )
        .replace(/\s+/g, ' ')
        .trim();
      if (!text || text.length > CTA_TEXT_LIMIT) continue;
      out.push({ el, text });
    }
  }
  return out;
}

// The single browser-entry action available on this page, or null if there is none.
async function findBrowserEntryAction(page) {
  for (const { el, text } of await visibleClickables(page)) {
    if (!BROWSER_ENTRY_PATTERN.test(text)) continue;
    // "Join from browser" contains "browser", but so would a hypothetical "Download the browser
    // app" - the native check runs second and wins, because clicking that one is the costly
    // mistake (it steals the foreground) while skipping a good link only costs a fallback.
    if (NATIVE_APP_PATTERN.test(text)) continue;
    return { kind: 'click', el, text };
  }
  const webClient = zoomWebClientUrl(page.url());
  if (webClient) return { kind: 'navigate', url: webClient, text: 'Zoom web client' };
  return null;
}

// Is something still standing between us and the call? Returns a description for the log/error,
// or null. Text-based as well as element-based, so it also catches an interstitial rendered
// without a real <button>.
async function matchVisibleText(page, pattern) {
  for (const frame of page.frames()) {
    const hit = await frame
      .evaluate((source) => {
        // innerText, not textContent: it reflects what is actually rendered, so hidden
        // template markup for other states does not count as the page's current state.
        const text = document.body ? document.body.innerText || '' : '';
        const m = text.match(new RegExp(source, 'i'));
        return m ? m[0] : null;
      }, pattern.source)
      .catch(() => null);
    if (hit) return hit;
  }
  return null;
}

async function describeJoinBlocker(page) {
  // Terminal states first: they outrank everything, including a waiting message left on screen
  // beside them, because there is nothing left to wait for.
  const ended = await matchVisibleText(page, TERMINAL_STATE_PATTERN);
  if (ended) return `the call is over or unavailable ("${ended.trim()}")`;

  const action = await findBrowserEntryAction(page).catch(() => null);
  if (action && action.kind === 'click') return `a "${action.text}" prompt is still on screen`;

  const preJoin = await matchVisibleText(page, PRE_JOIN_TEXT_PATTERN);
  if (preJoin) return `the page still shows "${preJoin.trim()}"`;

  return null;
}

// Exposed so the gauntlet can assert the healthy-wait states are NOT treated as blockers.
async function isLegitimateWait(page) {
  return Boolean(await matchVisibleText(page, LEGITIMATE_WAIT_PATTERN));
}

// Walks the browser-entry interstitials until the call itself is reached. Bounded, and every
// step is logged: a provider that changes its wording should surface as an unhandled pre-join
// screen in the log rather than as a silently mis-targeted capture.
// Returns the page the pipeline should CONTINUE with - normally the one passed in, but a new
// one if an entry link opened the call in its own tab. Capture is per-tab, so holding the wrong
// tab means recording the lobby while the call plays somewhere we never look.
async function advanceJoinFlow(page, logger) {
  for (let step = 0; step < MAX_JOIN_STEPS; step++) {
    const action = await findBrowserEntryAction(page).catch(() => null);
    if (!action) return page;

    const before = page.url();
    if (action.kind === 'navigate') {
      logger.info(`No in-page browser link; opening the web client directly: ${action.url}`);
      const ok = await page
        .goto(action.url, { waitUntil: 'domcontentloaded', timeout: 30000 })
        .then(() => true)
        .catch((err) => {
          logger.warn(`Could not open the web client at ${action.url}: ${err.message}`);
          return false;
        });
      if (!ok) return page;
    } else {
      logger.info(`Entering the call via "${action.text}".`);
      // Armed BEFORE the click: a target=_blank / window.open entry point fires immediately,
      // and a popup opened while we were not listening is one we can never adopt.
      const popupPromise = page.waitForEvent('popup', { timeout: POPUP_GRACE_MS }).catch(() => null);
      const clicked = await action.el
        .click({ timeout: 5000 })
        .then(() => true)
        .catch((err) => {
          logger.warn(`Could not click "${action.text}": ${err.message}`);
          return false;
        });
      if (!clicked) return page;

      const popup = await popupPromise;
      if (popup) {
        await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        if (/^https?:/i.test(popup.url())) {
          logger.info(`The call opened in a new tab (${popup.url()}); following it and closing the old one.`);
          const previous = page;
          page = popup;
          // Only after the new tab is confirmed usable, so a failed adoption cannot leave us
          // with nothing. Closing it matters: otherwise every such call leaks a tab.
          await previous.close().catch(() => {});
        } else {
          logger.warn(`A new tab opened at "${popup.url()}" but it is not a usable page; staying put.`);
          await popup.close().catch(() => {});
        }
      }
    }

    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
    // Zoom's web client swaps the whole view in after load rather than navigating again, so a
    // URL comparison alone would read that as a no-op and stop one step early.
    await page.waitForTimeout(1500);
    if (page.url() === before && action.kind === 'navigate') return page;
  }
  logger.warn(`Still on a pre-join screen after ${MAX_JOIN_STEPS} steps; continuing anyway.`);
  return page;
}

module.exports = {
  advanceJoinFlow,
  describeJoinBlocker,
  isLegitimateWait,
  TERMINAL_STATE_PATTERN,
  LEGITIMATE_WAIT_PATTERN,
  findBrowserEntryAction,
  zoomWebClientUrl,
  NATIVE_APP_PATTERN,
  BROWSER_ENTRY_PATTERN,
  PRE_JOIN_TEXT_PATTERN,
};
