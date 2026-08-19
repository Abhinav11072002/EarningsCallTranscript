const DIRECT_LINK_TEXT_PATTERN =
  /webcast|listen (live|now|online|to (the )?(call|webcast))|join (the )?(call|webcast)|audio\s*webcast|access\s*(the )?webcast|webcast link/i;

// Broader than DIRECT_LINK_TEXT_PATTERN on purpose: this looks for a link to a PAGE that might
// contain the real webcast link (e.g. an "Investor Relations" or "Events" nav item), not the
// call link itself. Deliberately requires fairly specific phrasing (not bare "investors" or
// "presentations") to keep the one-hop detour it triggers rare when it'd just be wasted.
const NAV_LINK_PATTERN = /investor relations|events?\s*(&|and)?\s*presentations?|webcasts?\b|earnings\s*(call|webcast)|news\s*(&|and)?\s*events?/i;
const MAX_HOPS = 2; // the initial landing page, plus at most one navigational hop deeper
// Legitimate call-to-action links ("Webcast", "Listen to the Webcast") are short. Long text
// merely containing a matching keyword is almost always a footer/branding line, e.g. "Webcasting
// Platform Powered by ACCESS Newswire Inc. (c) Copyright 2026 All Rights Reserved." - which
// contains "webcast" (inside "Webcasting") but isn't a link to the actual call at all. Confirmed
// live: this exact text matched and sent the resolver to a generic marketing page instead of the
// real webcast, which the original dial-in link had already pointed to directly.
const MAX_CTA_TEXT_LENGTH = 60;

function hostnameMatches(url, domains) {
  try {
    const hostname = new URL(url).hostname;
    return domains.some((d) => hostname.endsWith(d));
  } catch {
    return false;
  }
}

// Many IR "landing" pages link out to one of a small, fairly stable set of third-party
// webcast platforms (the same ones in config.json's knownDirectProviderDomains) even when the
// page's own wording varies wildly - so checking link DESTINATIONS by domain is more reliable
// than guessing every possible English phrasing. Runs before the text-based fallback below.
async function findKnownProviderLink(page, config) {
  const anchors = await page.$$('a[href]');
  for (const a of anchors) {
    const href = await a.getAttribute('href').catch(() => null);
    if (!href) continue;
    const absolute = new URL(href, page.url()).toString();
    if (hostnameMatches(absolute, config.knownDirectProviderDomains)) return absolute;
  }
  return null;
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
async function findNavigationalLink(page) {
  const anchors = await page.$$('a[href]');
  for (const a of anchors) {
    const text = ((await a.innerText().catch(() => '')) || '').trim();
    if (text.length > MAX_CTA_TEXT_LENGTH || !NAV_LINK_PATTERN.test(text)) continue;
    const href = await a.getAttribute('href').catch(() => null);
    if (!href) continue;
    return new URL(href, page.url()).toString();
  }
  return null;
}

// Tries the known-domain / embedded-iframe / known-link / text-match checks against whatever
// page is currently loaded. Returns true if one of them found (and where applicable,
// navigated to) a resolved webcast page.
async function tryResolveOnCurrentPage(page, config, logger) {
  const hostname = new URL(page.url()).hostname;
  if (config.knownDirectProviderDomains.some((d) => hostname.endsWith(d))) {
    logger.info(`Webcast resolved directly (known provider domain: ${hostname})`);
    return true;
  }

  const embeddedFrameUrl = await findEmbeddedProviderFrame(page, config).catch(() => null);
  if (embeddedFrameUrl) {
    logger.info(`Webcast player is embedded on this page (iframe: ${embeddedFrameUrl}) - staying on this page.`);
    return true;
  }

  const knownLink = await findKnownProviderLink(page, config).catch(() => null);
  if (knownLink) {
    logger.info(`Found link to known webcast provider: ${knownLink}`);
    await page.goto(knownLink, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return true;
  }

  const candidates = await page.$$('a, button');
  for (const el of candidates) {
    const text = ((await el.innerText().catch(() => '')) || '').trim();
    if (text.length > MAX_CTA_TEXT_LENGTH || !DIRECT_LINK_TEXT_PATTERN.test(text)) continue;

    logger.info(`Found candidate webcast link via text match: "${text}"`);
    const href = await el.getAttribute('href').catch(() => null);
    if (href) {
      await page.goto(new URL(href, page.url()).toString(), { waitUntil: 'domcontentloaded', timeout: 30000 });
    } else {
      await el.click().catch(() => {});
      await page.waitForLoadState('domcontentloaded').catch(() => {});
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
async function resolveWebcastPage(context, dialinUrl, config, logger) {
  const page = await context.newPage();
  await page.goto(dialinUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const resolved = await tryResolveOnCurrentPage(page, config, logger);
    if (resolved) return page;

    if (hop < MAX_HOPS - 1) {
      const navLink = await findNavigationalLink(page).catch(() => null);
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

module.exports = { resolveWebcastPage };
