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
      const inputs = Array.from(document.querySelectorAll('input, select, textarea')).filter((i) => {
        const r = i.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });

      const gapTo = (target, labelRect) => {
        const r = target.getBoundingClientRect();
        const verticalGap = r.top - labelRect.bottom;
        const horizontalOverlap = Math.min(r.right, labelRect.right) - Math.max(r.left, labelRect.left);
        if (verticalGap < -5 || verticalGap > 60 || horizontalOverlap <= -50) return Infinity;
        return verticalGap;
      };

      let best = null;
      let bestGap = Infinity;
      for (const c of candidates) {
        const text = (c.textContent || '').trim();
        if (!text || text.length > 60) continue;
        const r = c.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;

        const gap = gapTo(node, r);
        if (gap === Infinity || gap >= bestGap) continue;

        // Only accept a label if THIS field is the closest field to it. Without this check the
        // association can shift by one whole field when a layout puts inputs and labels in an
        // order the geometry does not expect - and a shifted association is worse than none,
        // because it types the email into the surname box and submits that.
        let ownedByAnother = false;
        for (const other of inputs) {
          if (other === node) continue;
          if (gapTo(other, r) < gap) {
            ownedByAnother = true;
            break;
          }
        }
        if (ownedByAnother) continue;

        bestGap = gap;
        best = text;
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

// Site chrome, not the registration gate. Verified against adversarial fixtures: a webcast page
// that is ALREADY joinable commonly carries a header "Sign In"/"Account" button and a footer
// newsletter email box. Counting those as a gate made the pipeline throw "Registration gate
// still appears active" and fail a call that was completely fine - and the newsletter box got
// the dummy email typed into it. Clicking a header "Sign In" is worse still: it navigates away
// from the player entirely.
const FURNITURE_SELECTOR = 'nav, header, footer, [role=navigation], [role=search], [role=banner], [role=contentinfo]';

// Inputs that look identity-ish but never belong to a gate. Excluded everywhere, regardless of
// position, because typing into them can trigger navigation or an autocomplete overlay that
// covers the player - and subscribing the dummy identity to a mailing list is a real side effect.
const IRRELEVANT_FIELD_PATTERN = /newsletter|subscrib|search|promo|coupon|discount|voucher/i;

// Buttons that must never be clicked while hunting for a registration CTA.
const IRRELEVANT_BUTTON_PATTERN = /subscrib|newsletter|search|cookie|privacy|settings|preferences/i;

// Gates we have no way to satisfy - a passcode, PIN, attendee ID or conference code. None of
// these match the identity patterns, so before this they read as "no gate at all".
const UNFILLABLE_GATE_PATTERN =
  /pass\s?code|passcode|access\s*(?:code|pin)|\bpin\b|confirmation\s*(?:number|code)|attendee\s*id|conference\s*id|event\s*code|entry\s*code|\bpassword\b/i;

function isFurniture(handle) {
  return handle
    .evaluate((node, selector) => Boolean(node.closest(selector)), FURNITURE_SELECTOR)
    .catch(() => false);
}

// Spam honeypots are positioned off-screen and expected to stay empty; filling one is a common
// way to get a registration silently rejected. Playwright's :visible only requires a non-empty
// box, so an element at left:-9999px still counts as visible - verified with a fixture whose
// honeypot received the dummy email.
function isOffscreen(handle) {
  return handle
    .evaluate((node) => {
      const r = node.getBoundingClientRect();
      const w = window.innerWidth || document.documentElement.clientWidth;
      const h = window.innerHeight || document.documentElement.clientHeight;
      return r.right < 0 || r.bottom < 0 || r.left > w || r.top > h;
    })
    .catch(() => false);
}

const CTA_BUTTON_PATTERN = /register|submit|enter|join|continue|watch now|listen now|access|attend/i;
const REGISTRATION_BUTTON_PATTERN = /register|registration|sign\s*in|log\s*in|account|continue\s+registration|continue\s+without|guest|join\s+(the\s+)?(webinar|conference|event)|attend\s+(the\s+)?event/i;

// Fields worth filling, split by how confident we are that they belong to the gate. Anything
// matching IRRELEVANT_FIELD_PATTERN (or a search box) is dropped entirely; anything inside site
// chrome is demoted to a fallback rather than dropped, so a gate that genuinely lives in a
// footer still works while a footer newsletter never gets touched.
async function collectFillableFields(frame, identity, allowFurnitureFallback) {
  const fields = await frame.$$('input:visible, select:visible, textarea:visible').catch(() => []);
  const primary = [];
  const fallback = [];
  for (const el of fields) {
    const tag = await el.evaluate((n) => n.tagName.toLowerCase());
    const type = ((await el.getAttribute('type')) || 'text').toLowerCase();
    if (['hidden', 'submit', 'button', 'checkbox', 'radio', 'search'].includes(type)) continue;

    if (await el.isDisabled().catch(() => false)) continue;
    if (await el.isEditable().catch(() => true) === false) continue; // readonly
    if (await isOffscreen(el)) continue;

    const description = await describeField(el);
    if (IRRELEVANT_FIELD_PATTERN.test(description)) continue;
    const key = matchField(description);
    if (!key || identity[key] === undefined) continue;

    const entry = { el, tag, description, key };
    if (await isFurniture(el)) fallback.push(entry);
    else primary.push(entry);
  }
  if (primary.length) return primary;
  if (!allowFurnitureFallback) return [];
  // The furniture fallback exists for a gate that genuinely lives in a footer. But when the page
  // offers a real registration BUTTON outside the chrome, this is a button-only gate (the Q4
  // pattern: nothing to type) and the only "identity" field around is almost certainly a
  // newsletter box - filling it subscribes the dummy identity and widens the set of buttons the
  // click step will accept.
  if (fallback.length && (await hasNonFurnitureRegistrationButton(frame))) return [];
  return fallback;
}

async function hasNonFurnitureRegistrationButton(frame) {
  const buttons = await frame
    .$$('button:visible, input[type=submit]:visible, input[type=button]:visible, a[role=button]:visible')
    .catch(() => []);
  for (const btn of buttons) {
    const text = ((await btn.innerText().catch(() => '')) || (await btn.getAttribute('value').catch(() => '')) || '').trim();
    if (!text || !REGISTRATION_BUTTON_PATTERN.test(text)) continue;
    if (IRRELEVANT_BUTTON_PATTERN.test(text)) continue;
    if (await isFurniture(btn)) continue;
    return true;
  }
  return false;
}

async function fillVisibleFields(frame, identity, logger) {
  const targets = await collectFillableFields(frame, identity);
  let filledCount = 0;
  for (const { el, tag, description, key } of targets) {
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
    // Never click site chrome or an unrelated CTA. A header "Sign In" matches the registration
    // pattern and would navigate away from the player; a footer "Subscribe" would submit a
    // newsletter form instead of the gate.
    if (IRRELEVANT_BUTTON_PATTERN.test(text)) continue;
    if (await isFurniture(btn)) continue;
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

// "Is a gate still blocking us?" - the answer gates the whole call, so it must only count
// evidence that plausibly belongs to a registration form. Site chrome and unrelated inputs are
// excluded for the reasons documented on FURNITURE_SELECTOR: counting them reported a gate on
// pages that were already joinable, which failed the call outright.
async function hasPendingRegistration(page) {
  for (const frame of page.frames()) {
    const fields = await frame.$$('input:visible, select:visible, textarea:visible').catch(() => []);
    for (const field of fields) {
      const type = ((await field.getAttribute('type').catch(() => '')) || 'text').toLowerCase();
      if (['hidden', 'submit', 'button', 'checkbox', 'radio', 'search'].includes(type)) continue;
      const description = await describeField(field);
      if (IRRELEVANT_FIELD_PATTERN.test(description)) continue;
      // A gate we cannot fill is still a gate. A passcode/PIN/attendee-ID field matches none of
      // the identity patterns, so such a page used to report "no gate" and get recorded - a
      // transcript of the passcode form. Counting it as pending makes that a loud failure.
      const unfillableGate = type === 'password' || UNFILLABLE_GATE_PATTERN.test(description);
      if (!unfillableGate && !matchField(description)) continue;
      if (await isFurniture(field)) continue;
      return true;
    }
    const buttons = await frame.$$('button:visible, input[type=submit]:visible, input[type=button]:visible, a[role=button]:visible').catch(() => []);
    for (const button of buttons) {
      const text = ((await button.innerText().catch(() => '')) || (await button.getAttribute('value').catch(() => '')) || '').trim();
      if (!REGISTRATION_BUTTON_PATTERN.test(text)) continue;
      if (IRRELEVANT_BUTTON_PATTERN.test(text)) continue;
      if (await isFurniture(button)) continue;
      return true;
    }
  }
  return false;
}

// Some providers show a confirmation message but leave the (now-filled) form on screen instead
// of replacing it. The pending check would then still see identity fields and report a gate,
// failing a call that actually registered fine. An explicit success acknowledgement outranks
// that inference.
const REGISTRATION_SUCCESS_PATTERN =
  /registration (complete|completed|successful|confirmed)|thank you for registering|you (are|have been) registered|registered for (the )?(conference|event|webcast)|successfully registered/i;

async function hasRegistrationSuccess(page) {
  for (const frame of page.frames()) {
    const found = await frame
      .evaluate((source) => {
        const re = new RegExp(source, 'i');
        const text = document.body ? document.body.innerText || '' : '';
        return re.test(text);
      }, REGISTRATION_SUCCESS_PATTERN.source)
      .catch(() => false);
    if (found) return true;
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
      // The furniture fallback is only for a first-pass gate that genuinely lives in site
      // chrome. Once we have acted, a remaining chrome-only field is page furniture (a footer
      // newsletter) that happens to look identity-shaped - filling it subscribes the dummy
      // identity and widens the set of buttons the click step will then accept.
      const filledCount = await fillVisibleFields(frame, identity, logger, step === 0 && !lastAction);
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
  // An error message outranks a success message (some pages show both, e.g. "registered" plus
  // "this email is not accepted"), so the error is checked first and wins.
  const error = await findRegistrationError(page);
  let pending = foundAny && (await hasPendingRegistration(page));
  if (pending && !error && (await hasRegistrationSuccess(page))) {
    logger.info('Registration acknowledged by the page; treating the gate as cleared.');
    pending = false;
  }
  if (error) logger.warn(`Registration page reports an error: ${error}`);
  if (lastAction && pending) logger.warn('Registration may still be incomplete after the available steps.');
  return { foundAny, pending, error: pending ? error : null };
}

module.exports = { fillRegistrationForm, matchField };
