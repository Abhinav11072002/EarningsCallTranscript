const DIRECT_LINK_TEXT_PATTERN = /webcast|listen live|listen now|join.*call|audio\s*webcast|access\s*webcast/i;

// Opens the dial-in link in a new tab and, if it lands on an IR/landing page rather than
// the actual call platform, tries to find and follow the real webcast link.
async function resolveWebcastPage(context, dialinUrl, config, logger) {
  const page = await context.newPage();
  await page.goto(dialinUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

  const hostname = new URL(page.url()).hostname;
  const isKnownDirect = config.knownDirectProviderDomains.some((d) => hostname.endsWith(d));
  if (isKnownDirect) {
    logger.info(`Webcast resolved directly (known provider domain: ${hostname})`);
    return page;
  }

  const candidates = await page.$$('a, button');
  for (const el of candidates) {
    const text = (await el.innerText().catch(() => '')) || '';
    if (!DIRECT_LINK_TEXT_PATTERN.test(text)) continue;

    logger.info(`Found candidate webcast link via text match: "${text.trim()}"`);
    const href = await el.getAttribute('href').catch(() => null);
    if (href) {
      await page.goto(new URL(href, page.url()).toString(), { waitUntil: 'domcontentloaded', timeout: 30000 });
    } else {
      await el.click().catch(() => {});
      await page.waitForLoadState('domcontentloaded').catch(() => {});
    }
    return page;
  }

  logger.warn(
    `Could not confidently resolve a webcast link on ${dialinUrl} (unknown provider). ` +
      `Proceeding with the page as-is; add this provider's domain/link pattern to config.json if this recurs.`
  );
  return page;
}

module.exports = { resolveWebcastPage };
