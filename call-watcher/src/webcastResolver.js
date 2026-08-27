const DIRECT_LINK_TEXT_PATTERN =
  /webcast|listen (live|now|online|to (the )?(call|webcast))|join (the )?(call|webcast)|audio\s*webcast|access\s*(the )?webcast|webcast link/i;

// Broader than DIRECT_LINK_TEXT_PATTERN on purpose: this looks for a link to a PAGE that might
// contain the real webcast link (e.g. an "Investor Relations" or "Events" nav item), not the
// call link itself. Deliberately requires fairly specific phrasing (not bare "investors" or
// "presentations") to keep the one-hop detour it triggers rare when it'd just be wasted.
// The optional "& presentations" group used to collapse this to a bare /events?/ substring
// match, so "Careers Events", "Eventbrite" and even "prevent" triggered the single available
// hop and burned it on an unrelated page - after which resolution gives up entirely.
const NAV_LINK_PATTERN = /investor relations|\bevents?\s*(?:&|and)\s*presentations?|\bwebcasts?\b|earnings\s*(?:call|webcast|release)|news\s*(?:&|and)\s*events?/i;
const MAX_HOPS = 2; // the initial landing page, plus at most one navigational hop deeper

// Every widenable limit now comes from the retry strategy, defaulting to the values that were
// module constants - so a first attempt behaves exactly as it did before this existed. See
// retryStrategy.js for why breadth is something to reach for only after precision has failed.
const { BASE } = require('./retryStrategy');

function limitsFrom(hints) {
  const s = (hints && hints.strategy) || BASE;
  return {
    maxHops: s.maxHops || MAX_HOPS,
    ctaTextLimit: s.ctaTextLimit || MAX_CTA_TEXT_LENGTH,
    navPattern: s.navPattern || NAV_LINK_PATTERN,
    ctaPattern: s.ctaPattern || DIRECT_LINK_TEXT_PATTERN,
    hrefPattern: s.hrefPattern || null,
    attempt: s.attempt || 1,
    label: s.label || 'precise',
  };
}
// Legitimate call-to-action links ("Webcast", "Listen to the Webcast") are short. Long text
// merely containing a matching keyword is almost always a footer/branding line, e.g. "Webcasting
// Platform Powered by ACCESS Newswire Inc. (c) Copyright 2026 All Rights Reserved." - which
// contains "webcast" (inside "Webcasting") but isn't a link to the actual call at all. Confirmed
// live: this exact text matched and sent the resolver to a generic marketing page instead of the
// real webcast, which the original dial-in link had already pointed to directly.
const MAX_CTA_TEXT_LENGTH = 60;

// Downloadable assets, not pages. Verified against a fixture: an IR page whose only
// provider-domain link was "Q2 2026 Earnings Presentation" (a PDF) resolved to the PDF, and the
// pipeline would then have "recorded" a PDF viewer tab - a capture that looks completely
// successful and contains no call audio.
const ASSET_PATH_PATTERN = /\.(pdf|zip|xlsx?|docx?|pptx?|csv|jpe?g|png|gif|svg|mp3|mp4|wav|ics)$/i;

// Wording that marks a link as a past recording or a document rather than the live call. Kept
// separate from scoring below because these should be actively avoided, not merely ranked low.
const STALE_LINK_PATTERN = /archive|replay|transcript|presentation|slides?\b|playback|on-?demand/i;

// The subset that is never worth following at ANY score. STALE_LINK_PATTERN only subtracts
// points, so when a replay was the sole candidate it still won - ECOR.L 2026Q2 followed a link
// reading "WEBCAST REPLAY" and landed on the March 2026 full-year results, an event five months
// past, and then filled in its registration form.
//
// A recording of the wrong call is the worst outcome this project has: it produces a transcript
// that looks entirely successful and is about something else. Nothing downstream can tell.
//
// Deliberately narrower than STALE_LINK_PATTERN. "Presentation" and "slides" describe the wrong
// KIND of resource and stay as penalties, because plenty of live calls are titled "Results
// Presentation" and refusing those outright would lose real calls. These four words only ever
// mean the event has already happened.
const NEVER_FOLLOW_PATTERN = /\breplays?\b|\barchived?\b|on-?demand|\bplaybacks?\b/i;

// A provider's own site is full of links to itself, and only one of them is the webcast. ZH
// 2026Q2 resolved to https://www.notified.com/privacy and failed all four attempts against a
// privacy policy: notified.com is a known provider, so a footer link to it looked exactly like
// the thing we were hunting for. Matching the DOMAIN was never enough - these paths are
// corporate furniture on every provider site, and none of them is ever a call.
const NON_WEBCAST_PATH_PATTERN =
  /\/(privacy|terms|legal|cookie|gdpr|about|about-us|contact|contact-us|careers|jobs|support|help|faq|blog|resources|pricing|products|solutions|company|press|newsroom|sitemap|accessibility|imprint)(?:[-_/]|$|\?|#)/i;   // the terminator allows a hyphen, so "terms-of-use" is caught too

function isNonWebcastPath(url) {
  try {
    const parsed = new URL(url);
    // The provider's bare homepage is not the call either.
    if (parsed.pathname === '/' || parsed.pathname === '') return true;
    return NON_WEBCAST_PATH_PATTERN.test(parsed.pathname);
  } catch {
    return true;
  }
}

function hostnameMatches(url, domains) {
  try {
    const hostname = new URL(url).hostname;
    // Dot-boundary aware: plain endsWith() would treat "notzoom.us" or "myq4inc.com" as a
    // configured provider.
    return domains.some((d) => hostname === d || hostname.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

function isAssetUrl(url) {
  try {
    return ASSET_PATH_PATTERN.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

// An "Events & Presentations" index commonly lists several quarters, and DOM order is not
// relevance - the archived quarter is often listed first. Scoring the candidates against the
// call we are actually here for makes the current quarter win. Falls back to DOM order when
// nothing scores, so pages with a single link behave exactly as before.
function scoreCandidate(text, url, hints) {
  const haystack = `${text} ${url}`.toLowerCase();
  let score = 0;
  if (hints) {
    if (hints.period && haystack.includes(String(hints.period).toLowerCase())) score += 3;
    if (hints.year && haystack.includes(String(hints.year).toLowerCase())) score += 2;
    if (hints.symbol && haystack.includes(String(hints.symbol).toLowerCase())) score += 1;
  }
  if (STALE_LINK_PATTERN.test(haystack)) score -= 4;
  return score;
}

// Many IR "landing" pages link out to one of a small, fairly stable set of third-party
// webcast platforms (the same ones in config.json's knownDirectProviderDomains) even when the
// page's own wording varies wildly - so checking link DESTINATIONS by domain is more reliable
// than guessing every possible English phrasing. Runs before the text-based fallback below.
async function findKnownProviderLink(page, config, hints) {
  const { hrefPattern } = limitsFrom(hints);
  const anchors = await page.$$('a[href]');
  const candidates = [];
  for (const [index, a] of anchors.entries()) {
    const href = await a.getAttribute('href').catch(() => null);
    if (!href) continue;
    let absolute;
    try {
      absolute = new URL(href, page.url()).toString();
    } catch {
      continue; // one malformed href must not abort the whole scan
    }
    // A known provider domain is the strongest signal, but later attempts also accept a link
    // whose PATH says webcast even on an unknown host. Some providers label the real link with
    // nothing useful - "Click here", an icon, a bare date - while the href says /webcast/ or
    // /event/ outright, and text-only matching can never find those.
    const knownHost = hostnameMatches(absolute, config.knownDirectProviderDomains);
    const shapeMatches = Boolean(hrefPattern && hrefPattern.test(new URL(absolute).pathname));
    if (!knownHost && !shapeMatches) continue;
    if (isAssetUrl(absolute)) continue;
    if (isNonWebcastPath(absolute)) continue;
    const text = ((await a.innerText().catch(() => '')) || '').trim();
    // Refused outright, not merely marked down. A replay is a recording of a call that has
    // already happened, and following one produces a transcript of the wrong event that looks
    // completely successful afterwards. See NEVER_FOLLOW_PATTERN.
    if (NEVER_FOLLOW_PATTERN.test(`${text} ${absolute}`)) continue;
    // A known host outranks a lucky-looking path, so precision still wins where both apply.
    const bonus = knownHost ? 2 : 0;
    candidates.push({ absolute, index, score: scoreCandidate(text, absolute, hints) + bonus });
  }
  if (!candidates.length) return null;
  // Highest score wins; DOM order breaks ties so single-candidate pages are unchanged.
  candidates.sort((a, b) => b.score - a.score || a.index - b.index);
  return candidates[0].absolute;
}

// The webcast player is sometimes embedded directly via <iframe> on the landing page itself,
// with no separate link to follow at all. Detected only for logging - deliberately NOT
// navigated into: preferCurrentTab capture grabs the whole tab (iframe content included), and
// standalone-loading an embedded player's URL outside its expected parent frame can fail
// (some players check for that) or lose the surrounding page's registration state.
async function findEmbeddedProviderFrame(page, config) {
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    if (hostnameMatches(frame.url(), config.knownDirectProviderDomains)) return frame.url();
  }
  return null;
}

// Looks for an obvious navigational link (Investor Relations / Events / Webcasts / Earnings
// Call) on a page that had no direct answer - in case the real webcast link is one click
// deeper than wherever the admin portal's dial-in link happens to land.
async function findNavigationalLink(page, hints) {
  const { ctaTextLimit, navPattern } = limitsFrom(hints);
  const anchors = await page.$$('a[href]');
  for (const a of anchors) {
    const text = ((await a.innerText().catch(() => '')) || '').trim();
    if (text.length > ctaTextLimit || !navPattern.test(text)) continue;
    const href = await a.getAttribute('href').catch(() => null);
    if (!href) continue;
    return new URL(href, page.url()).toString();
  }
  return null;
}

// Tries the known-domain / embedded-iframe / known-link / text-match checks against whatever
// page is currently loaded. Returns true if one of them found (and where applicable,
// navigated to) a resolved webcast page.
async function tryResolveOnCurrentPage(page, config, logger, hints) {
  const hostname = new URL(page.url()).hostname;
  if (hostnameMatches(page.url(), config.knownDirectProviderDomains)) {
    logger.info(`Webcast resolved directly (known provider domain: ${hostname})`);
    return true;
  }

  const embeddedFrameUrl = await findEmbeddedProviderFrame(page, config).catch(() => null);
  if (embeddedFrameUrl) {
    logger.info(`Webcast player is embedded on this page (iframe: ${embeddedFrameUrl}) - staying on this page.`);
    return true;
  }

  const knownLink = await findKnownProviderLink(page, config, hints).catch(() => null);
  if (knownLink) {
    logger.info(`Found link to known webcast provider: ${knownLink}`);
    await page.goto(knownLink, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return true;
  }

  const { ctaTextLimit, ctaPattern } = limitsFrom(hints);
  const candidates = await page.$$('a:visible, button:visible');
  for (const el of candidates) {
    const text = ((await el.innerText().catch(() => '')) || '').trim();
    if (text.length > ctaTextLimit || !ctaPattern.test(text)) continue;
    // The same refusal the href scan makes. This path matches on WORDING alone, which is
    // exactly where "WEBCAST REPLAY" scores well - it followed one on ECOR.L 2026Q2 and
    // registered for the March 2026 full-year results, an event five months past.
    if (NEVER_FOLLOW_PATTERN.test(text)) {
      logger.info(`Ignoring "${text}" - it is a recording of a call that has already happened.`);
      continue;
    }

    logger.info(`Found candidate webcast link via text match: "${text}"`);
    const href = await el.getAttribute('href').catch(() => null);
    if (href) {
      let absolute;
      try {
        absolute = new URL(href, page.url()).toString();
      } catch {
        continue; // malformed href - keep scanning instead of aborting
      }
      await page.goto(absolute, { waitUntil: 'domcontentloaded', timeout: 30000 });
      return true;
    }
    // A click that fails used to be swallowed and still reported as a successful resolution,
    // so the pipeline recorded the UN-clicked landing page. Common causes: the element is
    // covered by a cookie/consent overlay, or is outside a scroll container. Only treat this
    // as resolved if the click worked AND the page actually changed.
    const before = page.url();
    const clicked = await el
      .click({ timeout: 5000 })
      .then(() => true)
      .catch((err) => {
        logger.warn(`Candidate "${text}" could not be clicked: ${err.message}`);
        return false;
      });
    if (!clicked) continue;
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    if (page.url() === before && !(await findEmbeddedProviderFrame(page, config).catch(() => null))) {
      logger.warn(`Clicking "${text}" changed nothing; continuing to look.`);
      continue;
    }
    return true;
  }

  return false;
}

// Opens the dial-in link in a new tab and, if it lands on an IR/landing page rather than the
// actual call platform, tries to find and follow the real webcast link. If the first page has
// no direct answer, follows one bounded navigational hop (e.g. an "Investor Relations"/"Events"
// link) and re-checks there, in case the real link is one click deeper - capped at MAX_HOPS so
// a page with no real webcast link at all can't send this wandering indefinitely.
async function resolveWebcastPage(context, dialinUrl, config, logger, hints) {
  const { maxHops, attempt, label } = limitsFrom(hints);
  if (attempt > 1) logger.info(`Resolving with a wider search (attempt ${attempt}: ${label}).`);
  const page = await context.newPage();
  await page.goto(dialinUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // Provider shells often render the registration form or iframe after the initial document
  // event. Give their client-side bootstrap a short window before classifying the page.
  await page.waitForTimeout(1000);

  for (let hop = 0; hop < maxHops; hop++) {
    const resolved = await tryResolveOnCurrentPage(page, config, logger, hints);
    if (resolved) return page;

    if (hop < maxHops - 1) {
      const navLink = await findNavigationalLink(page, hints).catch(() => null);
      if (navLink) {
        logger.info(`No direct webcast link here; following navigational link: ${navLink}`);
        const navigated = await page
          .goto(navLink, { waitUntil: 'domcontentloaded', timeout: 30000 })
          .then(() => true)
          .catch(() => false);
        if (navigated) continue;
      }
    }
    break;
  }

  logger.warn(
    `Could not confidently resolve a webcast link on ${dialinUrl} (unknown provider). ` +
      `Proceeding with the page as-is; add this provider's domain/link pattern to config.json if this recurs.`
  );
  return page;
}

module.exports = { resolveWebcastPage, isNonWebcastPath };
