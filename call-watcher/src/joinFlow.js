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

// Zoom's web client asks, after "Join from browser", whether it may use the microphone and
// camera. It is a modal with TWO controls, so the single-control overlay rule does not see it,
// and neither phrasing is a browser-entry wording - so the join stopped dead on that screen and
// the call was reported as having no player. GWRE, GROW, PANW and RGS all ended there.
//
// Declining is the only correct answer. Capture takes the TAB's audio, not the machine's, so the
// microphone contributes nothing; granting it would put the room's own sound into a call we are
// only listening to.
const MEDIA_DECLINE_PATTERN =
  /continue without (?:the )?(?:microphone|mic|camera|audio|video)|without (?:microphone|mic) and (?:camera|video)|join without (?:audio|video|microphone|camera)/i;

// Never clicked, on any path. Kept separate from the decline wording because the two sit side by
// side in the same modal and the grant is the visually primary one.
const MEDIA_GRANT_PATTERN = /\buse (?:my |the )?(?:microphone|mic|camera|audio|video)\b/i;

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
    // Two backslashes, not one. These are template literals, where \b is the BACKSPACE
    // escape rather than a word boundary - so written with a single backslash this
    // alternative compiled to a pattern ending in an actual U+0008 character and could
    // never match anything. "Join on the web" is how several providers word the browser
    // option, and it was invisible to us the entire time.
    `join (?:on|from) the web\\b`,
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


// Wording that must never be clicked even when the shape is right. Mirrors the refusals the
// form filler already applies: a recording of a past event, a control that switches the form to
// a login view, an upsell, site furniture.
const OVERLAY_REFUSE_PATTERN =
  /\breplays?\b|\barchived?\b|on-?demand|\bplayback\b|already\s+regist|create\s+(?:a|an)?\s*account|sign\s*up|host\s*sign\s*in|subscrib|newsletter|cookie|privacy|download|slides?\b|transcript/i;

// ---------------------------------------------------------------- the shape, not the wording
//
// Every gate this project has missed was missed the same way: by WORDING. "Click Here to Watch
// Webcast" on eventsair, "NEXT" on brrmedia, "Enter" on webinar.net - three phrases, three
// separate fixes, and the fourth is out there. Roughly half the calls in the book are on
// providers we have never seen, spread across eighty-odd hosts with a handful of calls each, so
// enumerating vocabulary cannot catch up.
//
// What those pages had in common was a SHAPE: something player-sized on the page, covered by an
// overlay, and exactly one thing to click inside it. That is recognisable without knowing a
// single word of the copy, and it is what this looks for.
//
// The conditions are deliberately narrow, because a wrong click here is expensive - a native-app
// handler steals the foreground, a replay records the wrong event:
//
//   1. the overlay sits ON TOP at its own centre (elementFromPoint agrees), so a hidden or
//      decorative div cannot qualify
//   2. it holds EXACTLY ONE actionable control - one button is a door, three is a menu
//   3. it holds no text input, because a form is the form filler's business, not this
//   4. the control's wording passes every existing refusal: native app, replay, mode switch,
//      site furniture. The shape decides WHERE to look; the wording still decides what is safe
//   5. something player-shaped exists behind it, or the overlay is small enough to be a dialog
//      rather than the page itself
const OVERLAY_MIN_COVERAGE = 0.12; // of the viewport - smaller than this is a badge, not a gate
const OVERLAY_MAX_COVERAGE = 0.98;

function overlayEntryProbe() {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);

  const playerBehind = (() => {
    if (document.querySelector('audio, video')) return true;
    for (const el of document.querySelectorAll(
      'iframe, [class*="player" i], [id*="player" i], [class*="webcast" i], [class*="stream" i], [class*="media" i]'
    )) {
      const r = el.getBoundingClientRect();
      if (r.width >= 200 && r.height >= 100) return true;
    }
    return false;
  })();

  const candidates = [...document.querySelectorAll('div, section, aside, dialog, [role=dialog], [aria-modal="true"]')];
  const found = [];

  for (const overlay of candidates) {
    if (!visible(overlay)) continue;
    const rect = overlay.getBoundingClientRect();
    const coverage = (rect.width * rect.height) / viewportArea;
    if (coverage < OVERLAY_MIN_COVERAGE_PLACEHOLDER || coverage > OVERLAY_MAX_COVERAGE_PLACEHOLDER) continue;

    // On top at its own centre. Without this, any large wrapper div qualifies.
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) continue;
    const atPoint = document.elementFromPoint(cx, cy);
    if (!atPoint || !(overlay === atPoint || overlay.contains(atPoint))) continue;

    // A form belongs to the form filler.
    if (overlay.querySelector('input:not([type=hidden]):not([type=button]):not([type=submit]), select, textarea')) continue;

    const controls = [...overlay.querySelectorAll('button, [role=button], input[type=button], input[type=submit], a[href]')]
      .filter(visible)
      .filter((el) => (el.innerText || el.value || '').trim().length > 0);
    if (controls.length !== 1) continue;

    const control = controls[0];
    const text = (control.innerText || control.value || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 60) continue;

    // A dialog-shaped overlay is a gate on its own; a page-sized one only counts when there is
    // something player-shaped behind it to be gating.
    const dialogShaped = coverage <= 0.6;
    if (!dialogShaped && !playerBehind) continue;

    found.push({ text, coverage: Number(coverage.toFixed(3)), dialogShaped, playerBehind });
  }

  // Innermost first: a modal nested inside a backdrop should win over the backdrop.
  found.sort((a, b) => a.coverage - b.coverage);
  return found[0] || null;
}

// Returns the single clickable inside a qualifying overlay, or null.
async function findOverlayEntryAction(page) {
  for (const frame of page.frames()) {
    const source = overlayEntryProbe
      .toString()
      .replace('OVERLAY_MIN_COVERAGE_PLACEHOLDER', String(OVERLAY_MIN_COVERAGE))
      .replace('OVERLAY_MAX_COVERAGE_PLACEHOLDER', String(OVERLAY_MAX_COVERAGE));
    const candidate = await frame.evaluate(`(${source})()`).catch(() => null);
    if (!candidate) continue;

    // The shape found WHERE to look. The wording still decides whether it is safe to touch.
    if (NATIVE_APP_PATTERN.test(candidate.text)) continue;
    if (MEDIA_GRANT_PATTERN.test(candidate.text)) continue;
    if (OVERLAY_REFUSE_PATTERN.test(candidate.text)) continue;

    const handle = await frame
      .locator('button, [role=button], input[type=button], input[type=submit], a[href]')
      .filter({ hasText: candidate.text })
      .first();
    if (!(await handle.count().catch(() => 0))) continue;
    return { kind: 'click', el: handle, text: candidate.text, why: candidate.dialogShaped ? 'a dialog with one button' : 'an overlay over the player' };
  }
  return null;
}

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
async function findMediaDeclineAction(page) {
  for (const { el, text } of await visibleClickables(page)) {
    if (MEDIA_GRANT_PATTERN.test(text)) continue;
    if (!MEDIA_DECLINE_PATTERN.test(text)) continue;
    return { kind: 'click', el, text, why: 'declining microphone and camera' };
  }
  return null;
}

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

// Walks the browser-entry interstitials until the call itself is reached. Bounded, and every
// step is logged: a provider that changes its wording should surface as an unhandled pre-join
// screen in the log rather than as a silently mis-targeted capture.
// Returns the page the pipeline should CONTINUE with - normally the one passed in, but a new
// one if an entry link opened the call in its own tab. Capture is per-tab, so holding the wrong
// tab means recording the lobby while the call plays somewhere we never look.
async function advanceJoinFlow(page, logger) {
  for (let step = 0; step < MAX_JOIN_STEPS; step++) {
    // Wording first: an explicit "Join from your browser" is a stronger signal than any shape.
    // The structural rule is the fallback, for the gates whose copy we have never met.
    const action =
      (await findBrowserEntryAction(page).catch(() => null)) ||
      (await findMediaDeclineAction(page).catch(() => null)) ||
      (await findOverlayEntryAction(page).catch(() => null));
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
      logger.info(`Entering the call via "${action.text}"${action.why ? ` (${action.why})` : ''}.`);
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
  findOverlayEntryAction,
  OVERLAY_REFUSE_PATTERN,
  advanceJoinFlow,
  describeJoinBlocker,
  TERMINAL_STATE_PATTERN,
  LEGITIMATE_WAIT_PATTERN,
  findBrowserEntryAction,
  zoomWebClientUrl,
  NATIVE_APP_PATTERN,
  BROWSER_ENTRY_PATTERN,
  PRE_JOIN_TEXT_PATTERN,
  MEDIA_DECLINE_PATTERN,
  MEDIA_GRANT_PATTERN,
};
