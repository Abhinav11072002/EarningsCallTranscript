const FIELD_PATTERNS = [
  { key: 'firstName', regex: /first\s*name|fname|given\s*name/i },
  { key: 'lastName', regex: /last\s*name|lname|surname|family\s*name/i },
  { key: 'fullName', regex: /(?:^|\s)(?:full[\s_-]*name|your[\s_-]*name|name)(?:\s|$)/i },
  { key: 'email', regex: /e-?mail/i },
  { key: 'phone', regex: /phone|mobile|tel(ephone)?/i },
  { key: 'company', regex: /company|organi[sz]ation|institution|firm/i },
  { key: 'country', regex: /country/i },
];

async function describeField(el) {
  const [name, id, placeholder, aria, autocomplete, label, nearbyLabel] = await Promise.all([
    el.getAttribute('name'),
    el.getAttribute('id'),
    el.getAttribute('placeholder'),
    el.getAttribute('aria-label'),
    el.getAttribute('autocomplete'),
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
  return [name, id, placeholder, aria, autocomplete, label, nearbyLabel].filter(Boolean).join(' ');
}

function registrationFrames(page) {
  return page.frames();
}

async function waitForRegistrationSurface(page) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    for (const frame of registrationFrames(page)) {
      const controls = await frame
        .$$('input:visible, select:visible, textarea:visible, button:visible, [role=button]:visible')
        .catch(() => []);
      if (controls.length) return;
    }
    await page.waitForTimeout(250);
  }
}

function matchField(description) {
  let best = null;
  for (const { key, regex } of FIELD_PATTERNS) {
    const position = description.search(regex);
    if (position < 0) continue;
    if (!best || position < best.position) best = { key, position };
  }
  return best ? best.key : null;
}

const CTA_BUTTON_PATTERN = /register|submit|enter|join|continue|watch now|listen now|access|attend/i;
const REGISTRATION_BUTTON_PATTERN = /register|registration|sign\s*in|log\s*in|account|continue\s+registration|continue\s+without|guest|join\s+(the\s+)?(webinar|conference|event)|attend\s+(the\s+)?event/i;

async function fillVisibleFields(frame, identity, logger) {
  const fields = await frame.$$('input:visible, select:visible, textarea:visible').catch(() => []);
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
      const value = await el.inputValue();
      const selectedLabel = tag === 'select'
        ? await el.locator('option:checked').textContent().catch(() => '')
        : '';
      const retained = [value, selectedLabel].some((item) =>
        String(item || '').trim().toLowerCase() === String(identity[key]).trim().toLowerCase()
      );
      if (!retained) {
        logger.warn(`Field "${description.trim() || key}" did not retain the expected value.`);
        continue;
      }
      filledCount++;
    } catch (err) {
      logger.warn(`Could not fill field "${description.trim() || key}": ${err.message}`);
    }
  }
  return filledCount;
}

async function checkRequiredConsent(frame, logger) {
  const checkboxes = await frame.$$('input[type=checkbox]:visible').catch(() => []);
  for (const checkbox of checkboxes) {
    const description = await describeField(checkbox);
    if (!/agree|consent|terms|condition|privacy|subscribe/i.test(description)) continue;
    if (!(await checkbox.isChecked().catch(() => false))) {
      await checkbox.check().catch((err) => logger.warn(`Could not check consent box "${description}": ${err.message}`));
    }
  }
}

async function dismissCookieOverlays(page, logger) {
  const selectors = [
    '#onetrust-accept-btn-handler',
    '#accept-recommended-btn-handler',
    '#onetrust-reject-all-handler',
  ];
  for (const selector of selectors) {
    const button = page.locator(selector).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click({ timeout: 1000 }).catch((error) => logger.warn(`Could not dismiss cookie consent: ${error.message}`));
      return;
    }
  }
}

async function clickFirstMatchingButton(frame, logger, allowSubmitFallback = false, registrationOnly = false) {
  const buttons = await frame.$$('button:visible, input[type=submit]:visible, input[type=button]:visible, a[role=button]:visible').catch(() => []);
  const candidates = [];
  for (const btn of buttons) {
    const text = ((await btn.innerText().catch(() => '')) || (await btn.getAttribute('value').catch(() => '')) || '').trim();
    const type = ((await btn.getAttribute('type').catch(() => '')) || '').toLowerCase();
    const score = /continue\s+without|guest/i.test(text) ? 6 : /register|registration/i.test(text) ? 5 : /submit|continue|join|enter|watch now|listen now|access|attend/i.test(text) ? 4 : type === 'submit' ? 2 : 0;
    if (!score || (registrationOnly && !REGISTRATION_BUTTON_PATTERN.test(text))) continue;
    if (!CTA_BUTTON_PATTERN.test(text) && !(allowSubmitFallback && type === 'submit')) continue;
    candidates.push({ btn, text, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  for (const { btn, text } of candidates) {
    const clicked = await btn
      .click()
      .then(() => true)
      .catch((err) => {
        logger.warn(`Failed clicking button "${text}": ${err.message}`);
        return false;
      });
    if (clicked) {
      return true;
    }
  }
  return false;
}

async function hasPendingRegistration(page) {
  for (const frame of page.frames()) {
    const fields = await frame.$$('input:visible, select:visible, textarea:visible').catch(() => []);
    for (const field of fields) {
      const type = ((await field.getAttribute('type').catch(() => '')) || 'text').toLowerCase();
      if (!['hidden', 'submit', 'button', 'checkbox', 'radio'].includes(type) && matchField(await describeField(field))) {
        return true;
      }
    }
    const buttons = await frame.$$('button:visible, input[type=submit]:visible, input[type=button]:visible, a[role=button]:visible').catch(() => []);
    for (const button of buttons) {
      const text = ((await button.innerText().catch(() => '')) || (await button.getAttribute('value').catch(() => '')) || '').trim();
      if (REGISTRATION_BUTTON_PATTERN.test(text)) return true;
    }
  }
  return false;
}

async function findRegistrationError(page) {
  const errorPattern = /required|invalid|must be completed|please enter|please select|not accepted|denied|unable|error/i;
  for (const frame of page.frames()) {
    const messages = await frame.$$('body, [role=alert], .error, [class*=error], [id*=error]').catch(() => []);
    for (const message of messages) {
      const text = ((await message.innerText().catch(() => '')) || '').trim();
      if (text && text.length < 240 && errorPattern.test(text)) return text;
    }
  }
  return null;
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
  await waitForRegistrationSurface(page);
  await dismissCookieOverlays(page, logger);

  let foundAny = false;
  let lastAction = false;
  for (let step = 0; step < 4; step++) {
    let acted = false;
    for (const frame of registrationFrames(page)) {
      const fields = await frame.$$('input:visible, select:visible, textarea:visible').catch(() => []);
      const buttons = await frame.$$('button:visible, input[type=submit]:visible, input[type=button]:visible, a[role=button]:visible').catch(() => []);
      if (!fields.length && !buttons.length) continue;
      foundAny = true;
      const filledCount = await fillVisibleFields(frame, identity, logger);
      await checkRequiredConsent(frame, logger);
      const clicked = await clickFirstMatchingButton(frame, logger, filledCount > 0, filledCount === 0);
      if (filledCount || clicked) acted = true;
      if (filledCount || clicked) lastAction = true;
    }
    if (!acted) break;
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(800);
  }
  if (!foundAny) logger.info('No visible form fields or registration button found (probably no registration gate).');
  const pending = foundAny && await hasPendingRegistration(page);
  const error = pending ? await findRegistrationError(page) : null;
  if (error) logger.warn(`Registration page reports an error: ${error}`);
  if (lastAction && pending) logger.warn('Registration may still be incomplete after the available steps.');
  return { foundAny, pending, error };
}

module.exports = { fillRegistrationForm, matchField };
