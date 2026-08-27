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

// A symbol is not enough to identify a row, and assuming it was is what produced the ledger's
// "Click-resolved link does not extend the truncated prefix" failures.
//
// A symbol appears more than once for ordinary reasons - a dual listing, an earlier quarter,
// the same call listed twice - and the first occurrence in the DOM is not necessarily the row
// the caller is asking about. Measured live on GWRE: the table held nine rows for that symbol,
// the first one's Dialin Link cell was "-", and clicking it opened nothing at all while a row
// further down held the real link.
//
// So the truncated text the caller already has is used to pick the row. It is the one piece of
// evidence that belongs to THIS row and no other, and matching on it makes the prefix guard in
// index.js a formality rather than the only thing standing between us and the wrong call.
async function findDialinLinkHandle(page, symbol, expectedText) {
  return page.evaluateHandle(
    ({ targetSymbol, tol, expected }) => {
      function isVisible(el) {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }
      const textOf = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();

      const all = Array.from(document.querySelectorAll('body *:not(span)')).filter(isVisible);

      // Every occurrence, not the first. Matches tableWatcher.js's own trailing-"^" stripping so
      // the same rows are found here as there.
      const symbolEls = all.filter((el) => textOf(el).replace(/\^$/, '') === targetSymbol);
      if (!symbolEls.length) return null;
      const rowTops = symbolEls.map((el) => el.getBoundingClientRect().top);
      const onOneOfOurRows = (el) => {
        const top = el.getBoundingClientRect().top;
        return rowTops.some((rowTop) => Math.abs(rowTop - top) <= tol);
      };

      const smallestFirst = (els) =>
        els.slice().sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          return ra.width * ra.height - rb.width * rb.height;
        });

      // TEXT FIRST, geometry second, and the order is the fix.
      //
      // The column position comes from the first "Dialin Link" header on the page and does not
      // hold everywhere: the portal renders more than one section, so rows further down sit at a
      // different x and the column search finds nothing for them. When that happened this gave
      // up on the spot - nineteen of fifty links came back unresolvable on a table with history
      // in it - without ever trying the one piece of evidence that does not depend on layout.
      //
      // The truncated text alone is not enough either: every choruscall link shortens to the
      // same string, and 36 cells on that page carried it. So the text finds the candidates and
      // the row decides which one is ours.
      if (expected) {
        const byText = all.filter((el) => textOf(el) === expected && onOneOfOurRows(el));
        if (byText.length) return smallestFirst(byText)[0];
      }

      // Fallback: the Dialin Link column, on one of this symbol's rows. A cell holding "-" is
      // never the answer - that is a row with no link at all.
      const dialinHeader = all.find((el) => textOf(el) === 'Dialin Link');
      if (!dialinHeader) return null;
      const dialinX = dialinHeader.getBoundingClientRect().left;

      const inColumn = all.filter((el) => {
        const r = el.getBoundingClientRect();
        return Math.abs(r.left - dialinX) <= tol && onOneOfOurRows(el);
      });
      return smallestFirst(inColumn).find((cell) => textOf(cell) && textOf(cell) !== '-') || null;
    },
    { targetSymbol: symbol, tol: POSITION_TOLERANCE_PX, expected: expectedText || null }
  );
}

// Which of the two things went wrong, said plainly. "Could not re-locate the cell" and "the
// click opened nothing" have completely different causes - the table re-rendering under us
// versus the click missing the handler - and the same message for both hid that for a while.
async function locateOrExplain(portalPage, symbol, expectedText) {
  const handle = await findDialinLinkHandle(portalPage, symbol, expectedText);
  const element = handle.asElement();
  if (element) return element;
  await handle.dispose().catch(() => {});
  return null;
}

async function resolveDialinLinkByClick(context, portalPage, symbol, logger, expectedText) {
  const portalUrlBefore = portalPage.url();

  // Two attempts. The table re-renders on its own schedule, so a handle taken a moment before
  // the click can be detached by the time it lands - and the second attempt costs a second.
  let element = null;
  for (let attempt = 1; attempt <= 2 && !element; attempt++) {
    element = await locateOrExplain(portalPage, symbol, expectedText);
    if (!element && attempt === 1) {
      logger.warn(`Could not find ${symbol}'s Dialin Link cell; the table may have re-rendered. Retrying.`);
      await portalPage.waitForTimeout(1200);
    }
  }
  if (!element) {
    throw new Error(`Could not re-locate the Dialin Link cell for ${symbol} on the live table`);
  }

  const newPagePromise = context.waitForEvent('page', { timeout: 10000 });
  await element.click();

  let newPage;
  try {
    newPage = await newPagePromise;
  } catch (err) {
    // The click landed on something that is not the link - a padding wrapper, or a cell whose
    // handler sits on a child - so nothing opened. Saying which of the two failures this is
    // matters: the caller can tell "the row moved" from "the click missed", and only the second
    // is worth a different click target.
    throw new Error(
      `Clicked ${symbol}'s Dialin Link cell but nothing opened within 10s - the click may have ` +
        `landed on a wrapper rather than the link itself (${err.message})`
    );
  } finally {
    // Safety net: if the click somehow navigated the main portal tab itself instead of opening
    // a new one, get it back to watching the table rather than leaving it stranded elsewhere.
    if (portalPage.url() !== portalUrlBefore) {
      await portalPage.goto(portalUrlBefore, { waitUntil: 'domcontentloaded' }).catch(() => {});
    }
  }

  // Playwright fires 'page' at creation, and waitForLoadState resolves immediately for the
  // initial empty document - so without waiting for a real http(s) URL this could return
  // "about:blank", which then resolves to nothing and records a blank tab as a success.
  await newPage.waitForURL(/^https?:/i, { timeout: 15000 }).catch(() => {});
  const resolvedUrl = newPage.url();
  await newPage.close().catch(() => {});

  if (!/^https?:\/\//i.test(resolvedUrl)) {
    throw new Error(`Clicking the dial-in cell for ${symbol} produced no usable URL (got "${resolvedUrl}")`);
  }

  logger.info(`Resolved truncated link for ${symbol} by clicking it live: ${resolvedUrl}`);
  return resolvedUrl;
}

module.exports = { resolveDialinLinkByClick };
