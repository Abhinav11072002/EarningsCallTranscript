const FIELD_PATTERNS = [
  { key: 'firstName', regex: /first\s*name|fname|given\s*name/i },
  { key: 'lastName', regex: /last\s*name|lname|surname|family\s*name/i },
  { key: 'fullName', regex: /^\s*(full\s*name|your\s*name|name)\s*$/i },
  { key: 'email', regex: /e-?mail/i },
  { key: 'phone', regex: /phone|mobile|tel(ephone)?/i },
  { key: 'company', regex: /company|organi[sz]ation|firm/i },
  { key: 'country', regex: /country/i },
];

async function describeField(el) {
  const [name, id, placeholder, aria, label, nearbyLabel] = await Promise.all([
    el.getAttribute('name'),
    el.getAttribute('id'),
    el.getAttribute('placeholder'),
    el.getAttribute('aria-label'),
    el.evaluate((node) => {
      if (node.id) {
        const l = document.querySelector(`label[for="${node.id}"]`);
        if (l) return l.textContent;
      }
      const parentLabel = node.closest('label');
      return parentLabel ? parentLabel.textContent : null;
    }),
    // Fallback for forms where the visible label is just positioned above/near the input via
    // CSS, with no <label for=...>/wrapping association (common on custom-styled forms) - find
    // the nearest short text sitting just above this field, within its horizontal span.
    el.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const candidates = Array.from(document.querySelectorAll('label, p, span, div, legend'))
        .filter((c) => !c.contains(node) && !node.contains(c));

      let best = null;
      let bestGap = Infinity;
      for (const c of candidates) {
        const text = (c.textContent || '').trim();
        if (!text || text.length > 60) continue;
        const r = c.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;

        const verticalGap = rect.top - r.bottom;
        const horizontalOverlap = Math.min(rect.right, r.right) - Math.max(rect.left, r.left);
        // Label sits above the field (small positive gap) and roughly over the same columns.
        if (verticalGap >= -5 && verticalGap <= 60 && horizontalOverlap > -50 && verticalGap < bestGap) {
          bestGap = verticalGap;
          best = text;
        }
      }
      return best;
    }),
  ]);
  return [name, id, placeholder, aria, label, nearbyLabel].filter(Boolean).join(' ');
}

function matchField(description) {
  for (const { key, regex } of FIELD_PATTERNS) {
    if (regex.test(description)) return key;
  }
  return null;
}

const CTA_BUTTON_PATTERN = /register|submit|enter|join|continue|watch now|listen now|access/i;

async function fillVisibleFields(page, identity, logger) {
  const fields = await page.$$('input:visible, select:visible, textarea:visible').catch(() => []);
  let filledCount = 0;
  for (const el of fields) {
    const tag = await el.evaluate((n) => n.tagName.toLowerCase());
    const type = (await el.getAttribute('type')) || 'text';
    if (['hidden', 'submit', 'button', 'checkbox', 'radio'].includes(type)) continue;

    const description = await describeField(el);
    const key = matchField(description);
    if (!key || identity[key] === undefined) continue;

    try {
      if (tag === 'select') {
        await el.selectOption({ label: identity[key] }).catch(() => el.selectOption(identity[key]).catch(() => {}));
      } else {
        await el.fill(String(identity[key]));
      }
      filledCount++;
      logger.info(`Filled field "${description.trim() || key}" -> ${key}`);
    } catch (err) {
      logger.warn(`Could not fill field "${description.trim() || key}": ${err.message}`);
    }
  }
  return filledCount;
}

async function clickFirstMatchingButton(page, logger) {
  const buttons = await page.$$('button, input[type=submit], a[role=button]').catch(() => []);
  for (const btn of buttons) {
    const text = ((await btn.innerText().catch(() => '')) || (await btn.getAttribute('value').catch(() => '')) || '').trim();
    if (!text || !CTA_BUTTON_PATTERN.test(text)) continue;
    const clicked = await btn
      .click()
      .then(() => true)
      .catch((err) => {
        logger.warn(`Failed clicking button "${text}": ${err.message}`);
        return false;
      });
    if (clicked) {
      logger.info(`Clicked button "${text}"`);
      return true;
    }
  }
  return false;
}

// Best-effort registration handling for two patterns seen in the wild:
// 1. A real form with identity fields (name/email/company/...) - fill then submit.
// 2. Account/button-only gating with no fields at all (e.g. Q4 Inc.'s events platform once
//    already logged into a Q4 account - clicking "Register with a Q4 Account" then "Register
//    for event" is enough, sometimes across more than one screen, no typing needed).
// Logs everything it does so unrecognized/unhandled pages are visible rather than silent.
async function fillRegistrationForm(page, identity, logger) {
  // Registration forms/buttons often render in client-side after domcontentloaded, so an
  // immediate query can race the page and find nothing even when a gate exists.
  await page.waitForSelector('input:visible, select:visible, textarea:visible, button', { timeout: 3000 }).catch(() => {});

  let filledCount = await fillVisibleFields(page, identity, logger);
  if (filledCount > 0) {
    const clicked = await clickFirstMatchingButton(page, logger);
    if (!clicked) logger.warn('Filled form fields but could not find a submit/enter button.');
    return;
  }

  // No identity fields - try a button-only flow, following through up to a couple of screens
  // in case clicking one CTA (e.g. "Register with a Q4 Account") leads to another (e.g.
  // "Register for event") before landing on the actual call.
  for (let i = 0; i < 3; i++) {
    const clicked = await clickFirstMatchingButton(page, logger);
    if (!clicked) {
      if (i === 0) logger.info('No visible form fields or registration button found (probably no registration gate).');
      return;
    }
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(600);

    filledCount = await fillVisibleFields(page, identity, logger);
    if (filledCount > 0) {
      const submitted = await clickFirstMatchingButton(page, logger);
      if (!submitted) logger.warn('Filled fields after a button click but could not find a submit button.');
      return;
    }
  }
}

module.exports = { fillRegistrationForm };
