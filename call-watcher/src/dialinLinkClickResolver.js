// The portal truncates long dial-in links for display (a real truncated string, not just CSS -
// see tableWatcher.js), but confirmed live: clicking the cell opens a new tab to the correct,
// FULL destination anyway - the React click handler clearly has access to the complete URL in
// its own component state, even though the visible text was cut short.
//
// Playwright's element.click() is used deliberately instead of a plain page.evaluate(() =>
// el.click()): a JS-triggered synthetic click is often not enough to satisfy Chrome's popup
// blocker for the resulting window.open() (the same "needs a real trusted gesture" pattern
// already seen with the extension's getDisplayMedia call earlier in this project), whereas
// Playwright's click() dispatches real, trusted input via CDP.
const POSITION_TOLERANCE_PX = 6;

async function findDialinLinkHandle(page, symbol) {
  return page.evaluateHandle(
    ({ targetSymbol, tol }) => {
      function isVisible(el) {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }
      const textOf = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();

      const all = Array.from(document.querySelectorAll('body *:not(span)')).filter(isVisible);

      const dialinHeader = all.find((el) => textOf(el) === 'Dialin Link');
      if (!dialinHeader) return null;
      const dialinX = dialinHeader.getBoundingClientRect().left;

      // Matches tableWatcher.js's own trailing-"^" stripping, so this finds the same row.
      const symbolEl = all.find((el) => textOf(el).replace(/\^$/, '') === targetSymbol);
      if (!symbolEl) return null;
      const rowTop = symbolEl.getBoundingClientRect().top;

      const candidates = all.filter((el) => {
        const r = el.getBoundingClientRect();
        return Math.abs(r.top - rowTop) <= tol && Math.abs(r.left - dialinX) <= tol;
      });
      if (!candidates.length) return null;

      candidates.sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return ra.width * ra.height - rb.width * rb.height;
      });
      return candidates[0];
    },
    { targetSymbol: symbol, tol: POSITION_TOLERANCE_PX }
  );
}

async function resolveDialinLinkByClick(context, portalPage, symbol, logger) {
  const portalUrlBefore = portalPage.url();

  const handle = await findDialinLinkHandle(portalPage, symbol);
  const element = handle.asElement();
  if (!element) {
    throw new Error(`Could not re-locate the Dialin Link cell for ${symbol} on the live table`);
  }

  const newPagePromise = context.waitForEvent('page', { timeout: 10000 });
  await element.click();

  let newPage;
  try {
    newPage = await newPagePromise;
  } finally {
    // Safety net: if the click somehow navigated the main portal tab itself instead of opening
    // a new one, get it back to watching the table rather than leaving it stranded elsewhere.
    if (portalPage.url() !== portalUrlBefore) {
      await portalPage.goto(portalUrlBefore, { waitUntil: 'domcontentloaded' }).catch(() => {});
    }
  }

  await newPage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  const resolvedUrl = newPage.url();
  await newPage.close().catch(() => {});

  logger.info(`Resolved truncated link for ${symbol} by clicking it live: ${resolvedUrl}`);
  return resolvedUrl;
}

module.exports = { resolveDialinLinkByClick };
