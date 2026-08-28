const { NATIVE_APP_PATTERN, LEGITIMATE_WAIT_PATTERN } = require('./joinFlow');

// The separator is [\s_-]* everywhere, not \s*. Real ids are hyphenated or underscored -
// q4inc's registration form uses analyst-first-name, analyst-last-name, analyst-company-name -
// and "last\s*name" cannot match "last-name". On that form the id matched nothing, the field
// fell through to the geometric label guess, and the LAST NAME box was filled with the first
// name while the last name was never used at all.
const FIELD_PATTERNS = [
  { key: 'firstName', regex: /first[\s_-]*name|fname|given[\s_-]*name/i },
  { key: 'lastName', regex: /last[\s_-]*name|lname|surname|family[\s_-]*name/i },
  // The trailing boundary is (?![A-Za-z]) rather than (?:\s|$) because real labels carry
  // punctuation: "Name*:" is what ELMD's form actually says, and requiring whitespace or
  // end-of-string after "name" meant it never matched. The field was then claimed by the
  // email pattern picking up the neighbouring "Email*:" label, so the attendee's NAME was
  // filled with an email address and the form rejected the registration on every attempt.
  // Still anchored at the FRONT, so "username" and "filename" remain excluded.
  { key: 'fullName', regex: /(?:^|\s)(?:full[\s_-]*name|your[\s_-]*name|name)(?![A-Za-z])/i },
  { key: 'email', regex: /e-?mail/i },
  { key: 'phone', regex: /phone|mobile|tel(ephone)?/i },
  // BEFORE company, and the order is the whole point. The first pattern to match wins, and
  // q4inc labels its job-title field "Company Role" - which matches `company` on the word
  // "Company", so the role box was filled with the company name while the real company field
  // was left to a lookup that had already refused it. Two fields, one value, both wrong.
  //
  // Deliberately not bare "title": a salutation field is labelled "Title" too, and answering
  // that with a job title selects nothing and can fail the form. Observed unmatched on
  // reg.lumiengage.com, whose required "Position" field was left empty on every attempt.
  { key: 'jobTitle', regex: /job[\s_-]*title|position|\brole\b|designation|occupation/i },
  { key: 'company', regex: /company|organi[sz]ation|institution|firm/i },  // 'company-name' matches on 'company' alone
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
    //
    // Skipped entirely when the field already has a real label or aria-label. It is a fallback,
    // and using it as well as an explicit label only adds noise: a "Preferred contact time"
    // select picked up a nearby "First name", was therefore treated as a first-name field, and
    // the filler tried to select the dummy first name among its options. Measured live.
    el.evaluate((node) => {
      const labelled =
        (node.id && document.querySelector(`label[for="${node.id}"]`)) ||
        node.closest('label') ||
        node.getAttribute('aria-label');
      if (labelled) return null;
      const rect = node.getBoundingClientRect();
      const candidates = Array.from(document.querySelectorAll('label, p, span, div, legend'))
        .filter((c) => !c.contains(node) && !node.contains(c));
      const inputs = Array.from(document.querySelectorAll('input, select, textarea')).filter((i) => {
        const r = i.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });

      // Distance, not just height. First name and Last name sit side by side on the same row,
      // so both labels are the SAME vertical distance from both fields - and judging by height
      // alone, whichever came first in the DOM won for both. That is how a Last name box came
      // to be filled with a first name.
      //
      // Horizontal alignment breaks the tie: a label belongs to the field beneath it, not to
      // its neighbour two hundred pixels away. Vertical distance still dominates, so a label
      // genuinely above a field is never beaten by one merely closer sideways.
      // A field's GROUP: the largest ancestor that still contains only this field. On a table
      // form that is the <tr>; on a modern form it is the wrapper <div>; on a flat form with no
      // wrappers at all there is none.
      //
      // This is the single most reliable signal on a form, and it is not geometric: a label
      // inside the field's own group belongs to that field whatever the pixels say. It is also
      // how a person reads a form.
      //
      // Both bugs this replaced came from reaching outside the group for evidence. In a
      // two-column table every left-hand label is ALSO directly above the input on the next
      // row, and the above-the-field rule scores far better than the beside-the-field rule - so
      // each label was claimed by the row below it and then discarded as belonging to another
      // field, leaving every row after the first with no label at all.
      const groupOf = (node) => {
        let group = null;
        let el = node.parentElement;
        for (let depth = 0; el && depth < 6; depth++, el = el.parentElement) {
          if (el.querySelectorAll('input:not([type=hidden]), select, textarea').length !== 1) break;
          group = el;
        }
        return group;
      };

      // Plain edge-to-edge distance, used to order candidates inside a group where direction
      // carries no meaning - a group holds one field, so everything in it describes that field.
      const distanceTo = (target, labelRect) => {
        const r = target.getBoundingClientRect();
        const dx = Math.max(labelRect.left - r.right, r.left - labelRect.right, 0);
        const dy = Math.max(labelRect.top - r.bottom, r.top - labelRect.bottom, 0);
        return Math.round(Math.sqrt(dx * dx + dy * dy));
      };

      // Three placements, in strict preference order.
      //
      // Only the first existed until now, and it rejected the other two outright: a label
      // BESIDE a field has a negative vertical gap of roughly its own height, so it failed the
      // `verticalGap < -5` test and every two-column form - "Name:" to the left of the box, the
      // commonest layout in older registration pages - produced no label at all.
      //
      // The new tiers start at 7000 and 8000, far above any score an above-label can reach
      // (6099 at worst), so a label genuinely above a field always wins and nothing that
      // already worked changes behaviour.
      const gapTo = (target, labelRect) => {
        const r = target.getBoundingClientRect();
        const verticalGap = r.top - labelRect.bottom;
        const horizontalOverlap = Math.min(r.right, labelRect.right) - Math.max(r.left, labelRect.left);

        // 1. ABOVE the field.
        if (verticalGap >= -5 && verticalGap <= 60 && horizontalOverlap > -50) {
          const horizontalOffset = Math.abs(labelRect.left - r.left);
          return verticalGap * 100 + Math.min(horizontalOffset, 99);
        }

        // Both remaining placements need the two to be on the same visual row.
        const sameRow =
          Math.abs((labelRect.top + labelRect.bottom) / 2 - (r.top + r.bottom) / 2) <=
          Math.max(r.height, 16) / 2 + 4;

        // 2. LEFT of the field, on the same row. Capped at 220px so a label cannot claim a
        // field on the far side of the page.
        if (sameRow && labelRect.right <= r.left + 5) {
          const distance = r.left - labelRect.right;
          if (distance <= 220) return 7000 + Math.min(distance, 999);
        }

        // 3. INSIDE the field's own box - a floating label that has not risen yet, which is
        // what most modern component libraries render before the field is focused.
        if (sameRow && labelRect.left >= r.left - 5 && labelRect.right <= r.right + 5) {
          return 8000 + Math.min(Math.abs(labelRect.left - r.left), 999);
        }

        return Infinity;
      };

      let best = null;
      let bestGap = Infinity;
      const group = groupOf(node);
      for (const c of candidates) {
        const text = (c.textContent || '').trim();
        if (!text || text.length > 60) continue;
        // A candidate has to actually say something. openbriefing puts a required marker -
        // <span class="required">*</span> - immediately above every input and left-aligned with
        // it, so the horizontal tie-break below preferred that asterisk to the real label
        // sitting a few pixels to its right. Every field on that provider read as "*", matched
        // nothing, and the form was submitted empty: ten calls over three days, the single
        // biggest cause in the ledger.
        if (!/[A-Za-z]{2}/.test(text)) continue;
        const r = c.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;

        // Anything inside the field's own group outranks every geometric guess, by a margin
        // no geometric score can reach.
        const inGroup = Boolean(group && group.contains(c));
        // Inside a group, distance alone is not enough: a block of explanatory text in the next
        // column sits flush against the field's right edge, so its distance is zero and it beat
        // the actual label ten pixels to the left. A label precedes its field - in reading order
        // and therefore in the document - so anything that FOLLOWS the field is penalised. A
        // penalty rather than a ban, since it must still win when it is the only candidate.
        const follows = Boolean(
          node.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING
        );
        const gap = inGroup
          ? -100000 + Math.min(distanceTo(node, r), 999) + (follows ? 500 : 0)
          : gapTo(node, r);
        if (gap === Infinity || gap >= bestGap) continue;

        // Only accept a label if THIS field is the closest field to it. Without this check the
        // association can shift by one whole field when a layout puts inputs and labels in an
        // order the geometry does not expect - and a shifted association is worse than none,
        // because it types the email into the surname box and submits that.
        // Skipped inside a group: a group contains exactly one field by construction, so
        // there is no other field that could own the label.
        if (!inGroup) {
          let ownedByAnother = false;
          for (const other of inputs) {
            if (other === node) continue;
            if (gapTo(other, r) < gap) {
              ownedByAnother = true;
              break;
            }
          }
          if (ownedByAnother) continue;
        }

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

// Waits for a client-rendered gate to appear, but not for one that is never coming. Measured on
// the gauntlet: pages with no form controls at all (an ended-meeting notice, a Teams client
// chooser built from plain links) sat here for the full 8s each - and this runs under the
// pipeline lock, so that is 8s added to every later call in the same 15-minute window.
async function waitForRegistrationSurface(page) {
  const deadline = Date.now() + 8000;
  const started = Date.now();
  while (Date.now() < deadline) {
    let rendered = false;
    for (const frame of registrationFrames(page)) {
      const controls = await frame
        .$$('input:visible, select:visible, textarea:visible, button:visible, [role=button]:visible')
        .catch(() => []);
      if (controls.length) return;
      if (!rendered) {
        rendered = await frame
          .evaluate(() => {
            if (document.querySelector('a, audio, video, iframe, [class*="player" i]')) return true;
            return (document.body ? (document.body.innerText || '').trim().length : 0) > 200;
          })
          .catch(() => false);
      }
    }
    // The page has clearly finished rendering something - links, a player, or real prose - and
    // still has no form control. Whatever gate it has is not made of form controls, so there is
    // nothing left to wait for. A page still booting is blank and keeps the full budget.
    if (rendered && Date.now() - started > 2000) return;
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

// The Q&A box inside a call, which must never be typed into: it is visible to the company and
// to everyone else attending, and no recording depends on it. The required-field fallback typed
// "Other" into "Enter your questions here" on RZLV 2026Q2 before this existed.
//
// Matched on PHRASING, not on the bare word "question", and that distinction is the whole rule.
// Zoom names every field on its registration form question_first_name, question_last_name,
// question_email - it calls registration fields "questions" - so excluding the word outright
// broke every Zoom registration form in the book while fixing one player. BW LNG 2026Q2 was the
// call that showed it: three matched fields, none filled, "Register" clicked four times on an
// empty form.
const QA_FIELD_PATTERN =
  /ask (?:a |your )?question|your question|enter your question|questions? here|submit (?:a )?question|post a question|leave (?:a )?(?:comment|message)|your (?:comment|message|feedback)/i;

// Buttons that must never be clicked while hunting for a registration CTA.
// "Create Account" is an upsell, never a way in. q4inc shows it on the page AFTER a successful
// registration - "Want to avoid registration for future Q4 hosted earning events?" - and it
// matches REGISTRATION_BUTTON_PATTERN on the bare word "account", so a call that had just
// registered correctly was clicked straight off the event and onto identity.q4inc.com. We
// cannot create an account in any case: it needs a verified mailbox.
//
// "Host Sign in" is on Zoom's waiting-room screen, next to "Waiting for host to start the
// webinar". It matches the registration pattern on "sign in", and clicking it took a capture
// that had successfully joined and sent it to Zoom's login page instead. It is for the host;
// we are an attendee, and there is nothing behind it for us.
const IRRELEVANT_BUTTON_PATTERN =
  /subscrib|newsletter|search|cookie|privacy|settings|preferences|create\s+(?:a|an)?\s*account|sign\s*up|host\s*sign\s*in|sign\s*in\s+as\s+(?:a\s+)?host/i;

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
// box, so an element at left:-9999px still counts as visible - verified by the
// honeypot-and-disabled fixture, whose trap field used to receive the dummy email.
//
// Measured against the VIEWPORT, this also threw away every field below the fold. BW LNG's Zoom
// registration puts its three boxes at y=768 on an 800-tall window: all three enabled, editable
// and perfectly fillable, all three skipped, and "Register" was then clicked four times on an
// empty form. The page just needed scrolling, which Playwright does by itself before typing.
//
// So the comparison is against the DOCUMENT. A field further down the page is ordinary; a field
// parked outside the document entirely is the trap.
function isOffscreen(handle) {
  return handle
    .evaluate((node) => {
      const r = node.getBoundingClientRect();
      const top = r.top + window.scrollY;
      const left = r.left + window.scrollX;
      const docWidth = Math.max(
        document.documentElement.scrollWidth,
        document.body ? document.body.scrollWidth : 0
      );
      const docHeight = Math.max(
        document.documentElement.scrollHeight,
        document.body ? document.body.scrollHeight : 0
      );
      // The 50px margin keeps a field flush against an edge from being mistaken for a trap.
      return left + r.width < -50 || top + r.height < -50 || left > docWidth + 50 || top > docHeight + 50;
    })
    .catch(() => false);
}

// 600ms, not several seconds. A popup opened by a click fires essentially synchronously with
// it, so a longer window buys nothing - but it is paid on EVERY click that does not open one,
// which is almost all of them. Measured at 6000ms: the gauntlet stopped finishing at all,
// because four filler steps across several frames each waited the full timeout in turn.
const POPUP_GRACE_MS = 600;
// One definition, used by both the step loop and the click selection. They were separate
// strings before, and drifted: the click step learned to consider plain anchors while the step
// loop still did not count them as controls, so a page whose only gate was a link was skipped
// before the click step ever ran. The bug looked exactly like the anchor support not working.
const CLICKABLE_SELECTOR =
  'button:visible, input[type=submit]:visible, input[type=button]:visible, a[role=button]:visible, a[href]:visible';

// Words that mean a field is NOT a person's name, however much it looks like one.
const NOT_A_PERSON_NAME_PATTERN =
  /company|organi|business|firm|institution|file|user|screen|domain|host|event|account/i;

const CLICK_TIMEOUT_MS = 5000;
// A rendered select's options exist already; waiting longer cannot make a missing one appear.
const SELECT_TIMEOUT_MS = 2000;

// Entry CTAs for gates that have nothing to type - the page is one button away from the call.
// Kept separate from REGISTRATION_BUTTON_PATTERN because these are also accepted when no field
// was filled, which is exactly the case REGISTRATION_BUTTON_PATTERN was too narrow for: an
// "Enter event" button and a "Join the live webcast" button both matched nothing, so a
// one-click gate was left sitting on screen and recorded.
const ENTRY_BUTTON_PATTERN =
  /enter (?:the )?(?:event|webcast|call|meeting|room|here)|join (?:the )?(?:live )?(?:webcast|call|meeting|event|now)|access (?:the )?(?:webcast|event|call|live)|watch (?:the )?(?:live )?(?:webcast|stream|now)|listen (?:to )?(?:the )?(?:live )?(?:webcast|call|audio|now)|proceed (?:to )?(?:the )?(?:event|webcast|call)?/i;

// Wording that marks a link as the PAST recording rather than the live call. Mirrors
// webcastResolver.js's STALE_LINK_PATTERN: the resolver already refuses to navigate to these,
// and the form filler must equally refuse to click them - "Listen to the replay" scores as a
// perfectly good CTA otherwise, and produces a capture that looks entirely successful.
const STALE_BUTTON_PATTERN = /replay|archive|on-?demand|playback|recording|transcript|presentation|slides?\b|download/i;

// Controls that SWITCH THE FORM to a different mode rather than submitting it. Clicking one
// throws away everything just typed, which is worse than clicking nothing at all.
//
// "Already Registered?" on app.webinar.net is the example that cost the call: it matches the
// registration pattern on the word "Register", ties with the real submit button on score, and
// wins the tie by sitting earlier in the DOM. The filler completed the form, answered the
// consent, clicked it, and was returned to an empty login view - then did the same thing again.
//
// Never taken, even though on a RETRY we genuinely have already registered: re-registering
// works on every provider seen so far, and a wrongly-taken shortcut leaves no way back.
const MODE_SWITCH_PATTERN =
  /already\s+regist|already\s+have\s+an?\s+account|returning\s+(?:attendee|user|visitor)|(?:sign|log)\s*in\s+instead|switch\s+to\s+(?:login|sign)/i;

const CTA_BUTTON_PATTERN = /register|submit|enter|join|continue|watch now|listen now|access|attend/i;

// A form split across steps advances with a button that says none of the above. brrmedia asks
// for an email, a terms checkbox, and then "NEXT" - which matched nothing, so the email was
// typed into the same first step three times and the call was lost on a two-field form.
//
// Word-anchored and only ever accepted once a field has actually been filled, because "Next" is
// also what a carousel arrow says. If nothing was typed, there is no step to advance.
const STEP_ADVANCE_PATTERN = /^\s*(?:next|next\s+step|proceed|go\s+on)\s*(?:>|»|→|\u203a)?\s*$/i;
const REGISTRATION_BUTTON_PATTERN = /register|registration|sign\s*in|log\s*in|account|continue\s+registration|continue\s+without|guest|join\s+(the\s+)?(webinar|conference|event)|attend\s+(the\s+)?event/i;

// Fields worth filling, split by how confident we are that they belong to the gate. Anything
// matching IRRELEVANT_FIELD_PATTERN (or a search box) is dropped entirely; anything inside site
// chrome is demoted to a fallback rather than dropped, so a gate that genuinely lives in a
// footer still works while a footer newsletter never gets touched.
// A field that is plainly a name, that the strict patterns did not claim.
//
// FIELD_PATTERNS deliberately requires "name" at a word start or after a space, because a
// looser rule swallows "company_name", "file_name" and "username" - all of which want
// different values or none at all. That strictness costs the plain single-name field some
// forms use instead of a first/last pair: an id like "txtName" or "attendeeName" has no
// separator before "name", so nothing matched it and the field was left empty. Seen live on
// ELMD, where the whole registration failed for want of one name.
//
// So this is a LAST resort, applied only when no name field of any kind was matched, and only
// when exactly one candidate remains. If a form has two unclaimed name-ish fields we cannot
// tell which is which, and filling either would be a guess.
const NAME_ISH_PATTERN = /name/i;

async function findLoneNameField(frame, identity, alreadyMatched) {
  if (!identity.fullName) return null;
  // Only when the form gave us no name at all - never in preference to a real match.
  if (alreadyMatched.some((k) => k === 'firstName' || k === 'lastName' || k === 'fullName')) return null;

  const fields = await frame.$$('input:visible').catch(() => []);
  const candidates = [];
  for (const el of fields) {
    const type = ((await el.getAttribute('type')) || 'text').toLowerCase();
    if (!['text', 'search', ''].includes(type)) continue;
    if (await el.isDisabled().catch(() => false)) continue;
    if ((await el.inputValue().catch(() => '')) !== '') continue;
    if (await isOffscreen(el)) continue;
    if (await isFurniture(el)) continue;

    const description = await describeField(el);
    if (!NAME_ISH_PATTERN.test(description)) continue;
    if (NOT_A_PERSON_NAME_PATTERN.test(description)) continue;
    if (IRRELEVANT_FIELD_PATTERN.test(description)) continue;
    candidates.push({ el, description, key: 'fullName', tag: 'input' });
  }

  // Exactly one, or we would be guessing.
  return candidates.length === 1 ? candidates[0] : null;
}

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
    if (IRRELEVANT_FIELD_PATTERN.test(description) || QA_FIELD_PATTERN.test(description)) continue;
    const key = matchField(description);
    if (!key || identity[key] === undefined) continue;
    // "Attachment file name" ends in " name", which the fullName pattern matches - so a file
    // field was being filled with a person's name. The same trap catches "screen name",
    // "username" and "host name". Only the person-name keys are guarded: "Company name"
    // resolves to `company` on its own and must stay fillable.
    if (['firstName', 'lastName', 'fullName'].includes(key) && NOT_A_PERSON_NAME_PATTERN.test(description)) {
      continue;
    }

    const entry = { el, tag, description, key };
    if (await isFurniture(el)) fallback.push(entry);
    else primary.push(entry);
  }
  if (primary.length) {
    // A form may pair a matched field with an unmatched lone "Name" - so this runs even when
    // other fields matched, just never when a name field already did.
    const lone = await findLoneNameField(frame, identity, primary.map((p) => p.key));
    if (lone) primary.push(lone);
    return primary;
  }
  const lone = await findLoneNameField(frame, identity, []);
  if (lone) return [lone];
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

// allowFurnitureFallback must be threaded through: fillRegistrationForm has always passed it
// as a 4th argument, but this function only declared three, so collectFillableFields received
// `undefined` and the footer-gate fallback it guards could never run at all.
async function fillVisibleFields(frame, identity, logger, allowFurnitureFallback = false) {
  const targets = await collectFillableFields(frame, identity, allowFurnitureFallback);
  let filledCount = 0;
  const filledKeys = [];
  for (const { el, tag, description, key } of targets) {
    try {
      if (tag === 'select') {
        // Chosen in the page rather than through selectOption, which demands an exact label or
        // value and WAITS for one to appear - so asking a "Preferred contact time" dropdown for
        // "nocos" blocked for Playwright's 30-second default, inside the pipeline lock, for
        // nothing. The options of a rendered select are already there or they are not.
        const picked = await chooseSelectOption(el, identity[key], OTHER_OPTION_PATTERN.source);
        if (picked) {
          logger.info(`Answered "${(description || key).trim().slice(0, 50)}" with "${picked}".`);
          filledCount++;
          filledKeys.push(key);
        } else {
          logger.warn(`"${(description || key).trim().slice(0, 50)}" offers no option matching "${identity[key]}".`);
        }
        continue;
      } else {
        await el.fill(String(identity[key]));
      }
      const value = await el.inputValue();
      // el is an ElementHandle, which has no .locator() - that call threw on EVERY <select>,
      // was swallowed by the catch below, and made the field count as unfilled even though the
      // option had been selected correctly. filledCount drives whether the click step is
      // allowed its submit fallback and whether it restricts itself to registration-worded
      // buttons, so a form whose only field was a country dropdown was handled as though
      // nothing had been typed at all.
      const selectedLabel = tag === 'select'
        ? await el
            .evaluate((node) => (node.selectedOptions && node.selectedOptions[0] ? node.selectedOptions[0].textContent : ''))
            .catch(() => '')
        : '';
      const retained = [value, selectedLabel].some((item) =>
        String(item || '').trim().toLowerCase() === String(identity[key]).trim().toLowerCase()
      );
      if (!retained) {
        logger.warn(`Field "${description.trim() || key}" did not retain the expected value.`);
        continue;
      }
      filledCount++;
      filledKeys.push(key);
    } catch (err) {
      logger.warn(`Could not fill field "${description.trim() || key}": ${err.message}`);
    }
  }
  // A field can be filled, verified, and then emptied again before anything is submitted.
  //
  // Zoom's web client is the case that showed it: it mounts its own React state after the first
  // paint and overwrites whatever is already in the inputs. The fill succeeded, inputValue()
  // confirmed it, hydration then wiped both boxes, and "Join" was clicked on an empty form -
  // four times, once per step, each one looking in the log like a completed attempt.
  //
  // So the values are checked once more after a beat, and restored if they have gone. Cheap,
  // and it only ever acts when something really did clear them.
  if (filledCount) {
    await frame.page().waitForTimeout(700);
    const restored = [];
    for (const { el, tag, key, description } of targets) {
      if (tag === 'select') continue;
      const now = await el.inputValue().catch(() => null);
      if (now === null || String(now).trim()) continue;
      const ok = await el
        .fill(String(identity[key]))
        .then(() => true)
        .catch(() => false);
      if (ok) restored.push(key);
      else logger.warn(`Field "${description.trim() || key}" was cleared and could not be refilled.`);
    }
    if (restored.length) {
      logger.info(`Refilled ${restored.length} field(s) the page had cleared: ${restored.join(', ')}.`);
    }
  }

  // Logged for the same reason the click is: without it the log shows a form being submitted
  // and cannot say whether anything was typed into it first, and those two failures need
  // opposite fixes. One line per frame rather than one per field, so a long form stays legible.
  if (filledKeys.length) logger.info(`Filled ${filledKeys.length} field(s): ${filledKeys.join(', ')}.`);
  else if (targets.length) logger.info(`Found ${targets.length} fillable field(s) but none retained a value.`);
  return filledCount;
}


// Choosing an option from a <select> when the wording does not match ours exactly.
//
// selectOption() demands an exact label or value, and real dropdowns rarely oblige. Two on one
// RZLV 2026Q2 form, both required, both left unset, so the Submit button stayed disabled and
// all four attempts died on a timeout clicking it:
//
//   Country     we hold "USA"; the list says "United States"
//   Occupation  matched jobTitle, so we asked for "Analyst"; the list offers no such thing
//
// Four passes, narrowest first, and the last one is what makes a required dropdown answerable
// at all: if nothing we hold fits, take "Other". That is the same choice fillUnmatchedSelects
// makes for a dropdown we never understood, and the reasoning is identical - it is true, it is
// offered by nearly every such list, and it asserts nothing specific.
const COUNTRY_ALIASES = {
  usa: ['united states', 'united states of america', 'us', 'u s a', 'america'],
  us: ['united states', 'united states of america', 'usa'],
  uk: ['united kingdom', 'great britain', 'england'],
};

async function chooseSelectOption(el, wanted, otherSource) {
  return el
    .evaluate(
      (node, { want, other }) => {
        const norm = (value) =>
          String(value || '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, ' ')
            .trim();

        const aliases = {
          usa: ['united states', 'united states of america', 'us', 'u s a', 'america'],
          us: ['united states', 'united states of america', 'usa'],
          uk: ['united kingdom', 'great britain', 'england'],
        };

        const target = norm(want);
        const wants = new Set([target, ...(aliases[target] || []).map(norm)].filter(Boolean));
        // A placeholder carries an empty value on nearly every form; never "choose" one.
        const options = Array.from(node.options).filter((option) => option.value !== '');
        if (!options.length) return null;

        const pick =
          // 1. the text or the value, exactly
          options.find((option) => wants.has(norm(option.textContent)) || wants.has(norm(option.value))) ||
          // 2. one contains the other as a whole word run - "United States" against "United
          //    States of America", not "Ireland" against "Iceland"
          options.find((option) => {
            const text = norm(option.textContent);
            return [...wants].some((w) => w && (text.startsWith(w + ' ') || w.startsWith(text + ' ')));
          }) ||
          // 3. nothing we hold fits: "Other"
          options.find((option) => new RegExp(other, 'i').test(option.textContent || ''));

        if (!pick) return null;
        node.value = pick.value;
        node.dispatchEvent(new Event('input', { bubbles: true }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
        return (pick.textContent || '').trim();
      },
      { want: wanted, other: otherSource }
    )
    .catch(() => null);
}

// Dropdowns a registration form requires but that mean nothing to us - "Industry Affiliation",
// "How did you hear about us", "Attendee Type". They match no identity field, so they were left
// on their placeholder and the form refused to submit. Observed live on INTU 2026Q4, which
// failed all four attempts against an unanswered Industry Affiliation.
//
// "Other" is chosen deliberately rather than the first available option: it is the choice that
// is true, is offered by nearly every such dropdown, and cannot accidentally assert something
// specific about who is joining. If no such option exists the select is left alone - guessing
// at "Analyst" or "Institutional Investor" would be inventing an answer.
const OTHER_OPTION_PATTERN = /^\s*other\b|\bother\s*$/i;

async function fillUnmatchedSelects(frame, identity, logger) {
  const selects = await frame.$$('select:visible').catch(() => []);
  let filled = 0;
  for (const select of selects) {
    if (await select.isDisabled().catch(() => false)) continue;
    if (await isFurniture(select)) continue;

    const description = await describeField(select);
    // Anything we can answer properly is handled by the identity pass; do not override it.
    if (matchField(description)) continue;
    if (IRRELEVANT_FIELD_PATTERN.test(description)) continue;

    const current = (await select.inputValue().catch(() => '')) || '';
    // A select that already holds a real answer is left as it is - only placeholders qualify.
    if (current && !/^(|0|-1|none|select|choose|please)/i.test(current.trim())) continue;

    const chosen = await select
      .evaluate((node, source) => {
        const re = new RegExp(source, 'i');
        const option = Array.from(node.options).find((o) => re.test(o.textContent || '') && o.value);
        if (!option) return null;
        node.value = option.value;
        node.dispatchEvent(new Event('input', { bubbles: true }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
        return option.textContent.trim();
      }, OTHER_OPTION_PATTERN.source)
      .catch(() => null);

    if (chosen) {
      logger.info(`Answered "${(description || 'a dropdown').trim().slice(0, 60)}" with "${chosen}".`);
      filled++;
    }
  }
  return filled;
}

// A dropdown that is not a <select>.
//
// GTLB's registration on open-exchange.net asks for "Affiliation" and renders it as
// <button role="combobox"> which opens a [role=listbox] of [role=option] items. There is no
// <select> and no <input>, so every field query in this file walked straight past it - the
// diagnostic reported four fields, all matched, and the form could not be submitted because
// the fifth was required and invisible to us.
//
// This is not one provider's quirk. It is what every modern component library renders, and it
// is the last shape of form control the filler could not see at all.
//
// The choice is made exactly as it is for a real <select>: "Other" if it is offered, and
// nothing otherwise. GTLB's list is Buy-Side Analyst / Sell-Side Analyst / Individual
// Shareholder / Media / Employee / Other - and picking any of the first five would assert
// something specific and untrue about who is joining.
const COMBOBOX_SELECTOR = '[role=combobox], [aria-haspopup=listbox]';
const COMBOBOX_PLACEHOLDER_PATTERN = /^\s*(?:select(?:\s+an?\s+option)?|choose(?:\s+one)?|please\s+select|-{1,2}|)\s*$/i;

// A combobox carries its label the way a button does - through aria-labelledby, aria-label or
// its id - so describeField, which reads input attributes, has nothing to work with here.
async function describeCombobox(element) {
  return element
    .evaluate((node) => {
      const parts = [node.id || '', node.getAttribute('name') || '', node.getAttribute('aria-label') || ''];
      const labelledBy = node.getAttribute('aria-labelledby');
      if (labelledBy) {
        for (const id of labelledBy.split(/\s+/)) {
          const label = document.getElementById(id);
          if (label) parts.push((label.innerText || '').trim());
        }
      }
      return parts.filter(Boolean).join(' ');
    })
    .catch(() => '');
}

async function answerCustomComboboxes(frame, identity, logger) {
  const comboboxes = await frame.$$(COMBOBOX_SELECTOR).catch(() => []);
  let answered = 0;

  for (const combobox of comboboxes) {
    if (!(await combobox.isVisible().catch(() => false))) continue;
    if (await combobox.isDisabled().catch(() => false)) continue;
    if (await isFurniture(combobox)) continue;

    // A combobox that is really a text input with a suggestion list belongs to the normal fill
    // path, which has already had its turn at it.
    const tag = await combobox.evaluate((node) => node.tagName.toLowerCase()).catch(() => '');
    if (tag === 'input' || tag === 'select') continue;

    const shown = ((await combobox.innerText().catch(() => '')) || '').trim();
    // Already answered by a human or by the page's own default - leave it alone.
    if (!COMBOBOX_PLACEHOLDER_PATTERN.test(shown)) continue;

    const description = await describeCombobox(combobox);
    if (IRRELEVANT_FIELD_PATTERN.test(description)) continue;

    await combobox.click({ timeout: 4000 }).catch(() => {});
    await frame.page().waitForTimeout(600);

    // Options live outside the button, usually at the end of <body>, so they are searched for
    // across the frame rather than within the control.
    const options = await frame.$$('[role=option]:visible').catch(() => []);
    if (!options.length) {
      // Close it again: an open listbox covers whatever is underneath, and the submit button
      // is often underneath.
      await combobox.press('Escape').catch(() => {});
      continue;
    }

    // An identity value wins when the label asks for something we actually know.
    const key = matchField(description);
    const wanted = key && identity[key] ? String(identity[key]) : null;

    let picked = null;
    for (const option of options) {
      const text = ((await option.innerText().catch(() => '')) || '').trim();
      if (!text || COMBOBOX_PLACEHOLDER_PATTERN.test(text)) continue;
      const matches = wanted ? text.toLowerCase() === wanted.toLowerCase() : OTHER_OPTION_PATTERN.test(text);
      if (!matches) continue;
      const clicked = await option
        .click({ timeout: 3000 })
        .then(() => true)
        .catch(() => false);
      if (clicked) picked = text;
      break;
    }

    if (!picked) {
      await combobox.press('Escape').catch(() => {});
      logger.warn(
        `"${(description || 'a dropdown').trim().slice(0, 50)}" offers no answer we can honestly give; leaving it unset.`
      );
      continue;
    }

    await frame.page().waitForTimeout(400);
    logger.info(`Answered "${(description || 'a dropdown').trim().slice(0, 50)}" with "${picked}".`);
    answered++;
  }
  return answered;
}


// Last line of defence: a REQUIRED field that nothing identified is still filled.
//
// The form tells us it is required, we can see it is empty, and we submit anyway - so the
// provider rejects the whole registration over one box. INTU 2026Q4 lost all four attempts to a
// required "Industry Affiliation" on event.on24.com; every other field on that form was filled
// correctly.
//
// Guessing a value is safe here in a way that guessing a BUTTON never is. The worst case is a
// nonsense answer to a marketing question on a throwaway registration; the alternative is a
// certain failure. "Other" is the default because these fields are almost always a category -
// affiliation, industry, how did you hear about us - where it is also the honest answer.
//
// Types that cannot take a word are skipped rather than filled with rubbish, and a password is
// never guessed: a passcode gate is a real gate, and pretending to answer it would turn a clear
// failure into a confusing one.
const UNGUESSABLE_TYPES = ['password', 'number', 'date', 'datetime-local', 'time', 'month', 'week', 'url', 'file', 'color', 'range'];

async function fillRequiredUnmatched(frame, identity, logger) {
  const fields = await frame.$$('input:visible, textarea:visible').catch(() => []);
  let filled = 0;

  for (const el of fields) {
    const type = ((await el.getAttribute('type').catch(() => '')) || 'text').toLowerCase();
    if (['hidden', 'submit', 'button', 'checkbox', 'radio', 'search'].includes(type)) continue;
    if (UNGUESSABLE_TYPES.includes(type)) continue;
    if (await el.isDisabled().catch(() => false)) continue;
    if ((await el.isEditable().catch(() => true)) === false) continue;
    if (await isOffscreen(el)) continue;
    if (((await el.inputValue().catch(() => '')) || '').trim()) continue; // already answered

    const description = await describeField(el);
    if (IRRELEVANT_FIELD_PATTERN.test(description) || QA_FIELD_PATTERN.test(description)) continue;
    if (matchField(description)) continue; // the normal path owns this one
    if (await isFurniture(el)) continue;
    // Belt and braces on the one path that reached a live call. A registration form asks for
    // values in <input> elements; a free-text box on a player is a <textarea>, and inventing an
    // answer for one is never worth the risk of posting it to the call.
    if ((await el.evaluate((node) => node.tagName.toLowerCase()).catch(() => '')) === 'textarea') continue;

    const required = await el
      .evaluate((node) => {
        if (node.required || node.getAttribute('aria-required') === 'true') return true;
        if (/(^|[\s_-])required([\s_-]|$)/i.test(node.className || '')) return true;

        // Most forms mark this with an asterisk rather than an attribute, so the field's own
        // label and its own group are searched for one - and nothing wider.
        //
        // Climbing to any ancestor holding OTHER fields reads their asterisks as this one's. A
        // flat form with no wrappers put every field's label under one parent, and an earlier
        // version that allowed that marked an explicitly optional "Referred by (optional)" box
        // as required and answered it.
        let group = null;
        let el = node.parentElement;
        for (let depth = 0; el && depth < 6; depth++, el = el.parentElement) {
          if (el.querySelectorAll('input:not([type=hidden]), select, textarea').length !== 1) break;
          group = el;
        }

        const own = [];
        if (group) own.push(group);
        if (node.id) {
          const explicit = document.querySelector(`label[for="${node.id}"]`);
          if (explicit) own.push(explicit);
        }
        const wrapping = node.closest('label');
        if (wrapping) own.push(wrapping);

        return own.some((n) => (n.innerText || '').includes('*'));
      })
      .catch(() => false);
    if (!required) continue;

    // An email or phone box that reached here was not matched by wording, but its TYPE says
    // what belongs in it, and a real address beats "Other".
    const value =
      type === 'email' ? identity.email : type === 'tel' ? identity.phone : identity.fallbackAnswer || 'Other';

    const label = description.trim().slice(0, 60) || 'an unlabelled field';
    const ok = await el
      .fill(String(value))
      .then(() => true)
      .catch((err) => {
        logger.warn(`Could not fill required field "${label}": ${err.message}`);
        return false;
      });
    if (ok) {
      filled++;
      logger.info(`Filled required field "${label}" with "${value}" - no identity value matched it.`);
    }
  }
  return filled;
}

// Ticks a checkbox that a UI library has hidden behind its own label.
//
// The real input is often visually hidden and the styled <label> sits on top of it, so
// Playwright's check() retries for its full timeout and gives up with "<label ...> intercepts
// pointer events". Measured on q4inc, whose entire registration hinges on one such checkbox.
//
// The label is what a person clicks, so clicking the label is not a workaround - it is the
// correct target. check() is still tried first because it verifies the resulting state.
async function tickCheckbox(frame, checkbox, label, logger, reason) {
  if (await checkbox.isChecked().catch(() => false)) return true;

  const direct = await checkbox
    .check({ timeout: 3000 })
    .then(() => true)
    .catch(() => false);
  if (direct) {
    logger.info(`Ticked ${reason}: ${label}`);
    return true;
  }

  const clickedLabel = await checkbox
    .evaluate((node) => {
      const target =
        (node.id && document.querySelector(`label[for="${node.id}"]`)) || node.closest('label');
      if (!target) return false;
      target.click();
      return true;
    })
    .catch(() => false);

  if (clickedLabel && (await checkbox.isChecked().catch(() => false))) {
    logger.info(`Ticked ${reason} via its label: ${label}`);
    return true;
  }

  logger.warn(`Could not tick ${reason} "${label}" - neither the box nor its label responded.`);
  return false;
}

// Checkboxes that make OTHER fields unnecessary.
//
// q4inc's guest form requires a Company Name, and supplies it through a lookup against their
// own directory of institutions: a made-up name returns "0 results", free text is discarded on
// blur, and the form cannot be submitted. There is no way to answer it.
//
// The way through is the box marked "I am an individual attendee", which turns both Company
// Name and Company Role into "(not required)" and clears the error. Ticking it is not a trick -
// it is simply true of the identity being used, which represents no institution.
//
// Six calls in the current book and seven in the last three days were lost to this one box.
const WAIVER_CHECKBOX_PATTERN =
  /individual attendee|individual investor|retail investor|private investor|not affiliated|no company|do not represent/i;

const CONSENT_TEXT_PATTERN = /agree|consent|terms|condition|privacy|policy|acknowledge|accept/i;

// A consent question can be a Yes/No RADIO PAIR rather than a checkbox, and until now nothing
// answered those. app.webinar.net asks:
//
//   ( ) Yes. I understand that my information will be processed and shared with the host
//   ( ) No. I do not want my information processed
//
// Neither is pre-selected, one of them is required, so the form was rejected and the call was
// reported as a registration failure with every text field correctly filled. The diagnostic
// showed it plainly - two radios, "-- no match --".
//
// Answering a radio needs more care than ticking a checkbox, because the wrong option is
// actively harmful: "No" is right there next to "Yes", and choosing it submits a refusal that
// keeps us out for good rather than leaving the form untouched. Three conditions therefore have
// to hold together before anything is clicked:
//
//   1. the group offers both an affirmative AND a negative option - a Yes/No shape, not a list
//   2. the two are unambiguous: an option matching BOTH patterns disqualifies itself, so
//      "No. I understand, but do not want..." is left alone rather than read as agreement
//   3. the subject matter is consent, not just any yes/no question
//
// When any of them fails the group is skipped. Doing nothing loses a call; answering "No"
// loses it and cannot be retried.
const AFFIRMATIVE_CONSENT_PATTERN = /\byes\b|\bi (?:agree|consent|accept|understand)\b|\bopt[\s-]?in\b/i;
const NEGATIVE_CONSENT_PATTERN =
  /\bno\b|\bi do not\b|\bi don'?t\b|\bdo not want\b|\bopt[\s-]?out\b|\bdecline\b|\brefuse\b/i;
const CONSENT_SUBJECT_PATTERN =
  /consent|process(?:ed|ing)?|privacy|policy|terms|personal (?:data|information)|my (?:data|information|details)|communications?|marketing|contact me|shared? with/i;

async function answerConsentRadios(frame, logger) {
  const radios = await frame.$$('input[type=radio]:visible').catch(() => []);
  const groups = new Map();

  for (const radio of radios) {
    if (await isFurniture(radio)) continue;
    // Grouped by name, which is what makes them mutually exclusive in the first place. Radios
    // with no name are grouped together under one key rather than dropped: a hand-rolled form
    // that manages exclusivity in JavaScript still asks a single question.
    const name = (await radio.getAttribute('name').catch(() => '')) || '(unnamed)';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push({ radio, description: await describeField(radio) });
  }

  for (const options of groups.values()) {
    if (options.length < 2) continue;

    let alreadyAnswered = false;
    for (const option of options) {
      if (await option.radio.isChecked().catch(() => false)) alreadyAnswered = true;
    }
    if (alreadyAnswered) continue;

    // Mutual exclusion, not just a match: see condition 2 above.
    const affirmative = options.find(
      (o) => AFFIRMATIVE_CONSENT_PATTERN.test(o.description) && !NEGATIVE_CONSENT_PATTERN.test(o.description)
    );
    const negative = options.find(
      (o) => NEGATIVE_CONSENT_PATTERN.test(o.description) && !AFFIRMATIVE_CONSENT_PATTERN.test(o.description)
    );
    if (!affirmative || !negative) continue;
    if (!CONSENT_SUBJECT_PATTERN.test(options.map((o) => o.description).join(' '))) continue;

    const label = affirmative.description.trim().slice(0, 60) || 'an unlabelled option';
    await affirmative.radio
      .check()
      .then(() => logger.info(`Answered a consent question: ${label}`))
      .catch((err) => logger.warn(`Could not select consent option "${label}": ${err.message}`));
  }
}

async function checkRequiredConsent(frame, logger) {
  const checkboxes = await frame.$$('input[type=checkbox]:visible').catch(() => []);
  for (const checkbox of checkboxes) {
    if (await checkbox.isChecked().catch(() => false)) continue;
    if (await isFurniture(checkbox)) continue;

    const description = await describeField(checkbox);
    let reason = CONSENT_TEXT_PATTERN.test(description) ? 'wording' : null;

    // A REQUIRED checkbox on a registration form has to be ticked whatever it says. Observed
    // live on SMTC 2027Q2, which failed all four attempts on an unchecked terms box: its label
    // was not associated with the input in any way describeField could see, so the wording
    // test alone never matched it.
    if (!reason) {
      const required = await checkbox
        .evaluate((node) => node.required || node.getAttribute('aria-required') === 'true')
        .catch(() => false);
      if (required) reason = 'required';
    }

    // Last resort: the visible text of the container the checkbox sits in. Custom-styled forms
    // routinely put the wording in a sibling element with no `for`, no wrapping label and no
    // aria-label - invisible to every attribute-based check, and perfectly obvious on screen.
    if (!reason) {
      const nearbyText = await checkbox
        .evaluate((node) => {
          let el = node.parentElement;
          for (let depth = 0; el && depth < 3; depth++, el = el.parentElement) {
            const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
            // Bounded: a whole form's text would match almost anything.
            if (text && text.length <= 300) return text;
          }
          return '';
        })
        .catch(() => '');
      if (CONSENT_TEXT_PATTERN.test(nearbyText)) reason = 'nearby text';
    }

    if (!reason) continue;
    const label = (description || '').trim().slice(0, 60) || 'an unlabelled checkbox';
    await tickCheckbox(frame, checkbox, label, logger, `consent checkbox (${reason})`);
  }
}

// Ticked BEFORE anything is filled, because it changes what the form requires: on q4inc it
// turns the unanswerable Company Name lookup into an optional field, so the fill that follows
// has nothing left to fail on.
async function tickWaiverCheckboxes(frame, logger) {
  const checkboxes = await frame.$$('input[type=checkbox]:visible').catch(() => []);
  for (const checkbox of checkboxes) {
    if (await checkbox.isChecked().catch(() => false)) continue;
    if (await isFurniture(checkbox)) continue;

    const description = await describeField(checkbox);
    if (!WAIVER_CHECKBOX_PATTERN.test(description)) continue;

    const label = (description || '').trim().slice(0, 60) || 'an unlabelled checkbox';
    await tickCheckbox(frame, checkbox, label, logger, 'the individual-attendee box');
  }
}

// Wording used to get past a consent/terms modal. Only ever applied INSIDE a detected overlay
// (see below), never to the page at large - "I agree" also appears next to checkboxes and in
// footers, and clicking those is either useless or actively wrong.
const OVERLAY_DISMISS_PATTERN =
  /accept(?: all| cookies)?|i (?:agree|understand|accept)|agree(?: to)?(?: the)?(?: terms)?|got it|allow all|continue to (?:the )?site|acknowledge|close|dismiss|ok\b/i;

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
  await dismissBlockingOverlays(page, logger);
}

// A terms/consent modal that COVERS the entry button. Playwright refuses to click an element
// another node is painted over, so before this the click simply timed out (5s, under the
// pipeline lock) and the call was abandoned at a gate one button away from being cleared.
//
// Detection is geometric rather than by class name: a fixed/sticky element with a high z-index
// covering a quarter of the viewport is a modal whatever it calls itself. That is what keeps
// this from firing on ordinary page furniture.
async function dismissBlockingOverlays(page, logger) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const handles = await page.$$('div:visible, section:visible, aside:visible, dialog:visible').catch(() => []);
    let dismissed = false;
    for (const handle of handles) {
      const isOverlay = await handle
        .evaluate((node) => {
          const style = getComputedStyle(node);
          if (!['fixed', 'sticky'].includes(style.position)) return false;
          if ((parseInt(style.zIndex, 10) || 0) < 100) return false;
          const r = node.getBoundingClientRect();
          const w = window.innerWidth || 1;
          const h = window.innerHeight || 1;
          return (r.width * r.height) / (w * h) > 0.25;
        })
        .catch(() => false);
      if (!isOverlay) continue;

      const buttons = await handle.$$('button:visible, a[role=button]:visible, input[type=button]:visible').catch(() => []);
      for (const btn of buttons) {
        const text = ((await btn.innerText().catch(() => '')) || (await btn.getAttribute('value').catch(() => '')) || '').trim();
        if (!text || text.length > 60 || !OVERLAY_DISMISS_PATTERN.test(text)) continue;
        const ok = await btn.click({ timeout: 2000 }).then(() => true).catch(() => false);
        if (ok) {
          logger.info(`Dismissed a blocking overlay via "${text}".`);
          dismissed = true;
          break;
        }
      }
      if (dismissed) break;
    }
    if (!dismissed) return;
    await page.waitForTimeout(400);
  }
}

// Clicks, and follows the call if the click opened it in a new tab. Capture is per-tab, so a
// target=_blank / window.open entry point that we do not follow leaves us holding the landing
// page while the call plays in a tab nothing is watching - a capture that looks entirely
// successful and contains none of the call. Verified against both fixtures in the gauntlet.
async function clickAndAdoptPopup(page, btn, text, logger) {
  // Armed before the click: a popup opened while we were not listening cannot be adopted.
  const popupPromise = page.waitForEvent('popup', { timeout: POPUP_GRACE_MS }).catch(() => null);
  const clicked = await btn
    .click({ timeout: CLICK_TIMEOUT_MS })
    .then(() => true)
    .catch((err) => {
      logger.warn(`Failed clicking button "${text}": ${err.message}`);
      return false;
    });
  if (!clicked) return { clicked: false, page };

  const popup = await popupPromise;
  if (!popup) return { clicked: true, page };

  await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  if (!/^https?:/i.test(popup.url())) {
    logger.warn(`"${text}" opened a new tab at "${popup.url()}" which is not usable; staying put.`);
    await popup.close().catch(() => {});
    return { clicked: true, page };
  }
  logger.info(`"${text}" opened the call in a new tab (${popup.url()}); following it and closing the old one.`);
  const previous = page;
  await previous.close().catch(() => {});
  return { clicked: true, page: popup };
}

async function clickFirstMatchingButton(page, frame, logger, allowSubmitFallback = false, registrationOnly = false) {
  // Plain anchors are included, which they were not before: a real gate is often just a link
  // ("Join the live webcast" as an <a target="_blank">), and skipping those meant the pipeline
  // walked past a one-click entry and recorded the landing page. Anchors are held to a stricter
  // bar than buttons below - entry/registration wording only, never the loose CTA or
  // submit-type fallbacks - because every page is full of links and most of them lead away.
  const buttons = await frame.$$(CLICKABLE_SELECTOR).catch(() => []);
  const candidates = [];
  for (const btn of buttons) {
    const tag = await btn.evaluate((n) => n.tagName.toLowerCase()).catch(() => '');
    const isPlainAnchor = tag === 'a';
    const text = ((await btn.innerText().catch(() => '')) || (await btn.getAttribute('value').catch(() => '')) || '').trim();
    const type = ((await btn.getAttribute('type').catch(() => '')) || '').toLowerCase();
    // Never click site chrome or an unrelated CTA. A header "Sign In" matches the registration
    // pattern and would navigate away from the player; a footer "Subscribe" would submit a
    // newsletter form instead of the gate.
    if (IRRELEVANT_BUTTON_PATTERN.test(text)) continue;
    // "Join from Zoom Workplace app" matches the CTA pattern on the bare word "join", and
    // clicking it fires a zoommtg:// handler whose OS dialog steals the foreground - which is
    // exactly what the extension keystroke needs moments later. See joinFlow.js.
    if (NATIVE_APP_PATTERN.test(text)) continue;
    if (STALE_BUTTON_PATTERN.test(text)) continue;
    if (MODE_SWITCH_PATTERN.test(text)) continue;
    if (await isFurniture(btn)) continue;
    const entryWorded = REGISTRATION_BUTTON_PATTERN.test(text) || ENTRY_BUTTON_PATTERN.test(text);
    // entryWorded has to earn a score of its own, or it is discarded two lines below by
    // `if (!score)` before anything can act on it - which is what happened to every CTA whose
    // wording ENTRY_BUTTON_PATTERN recognises but this narrower list does not.
    //
    // "Click Here to Watch Webcast" is the case that exposed it: ENTRY_BUTTON_PATTERN matches
    // it on "Watch Webcast", but the list below only has "watch now", the button is
    // type="button" rather than submit, so it scored 0 and was skipped. loghic.eventsair.com
    // presents exactly one control - that button, no fields at all - so the run ended with
    // "Controls present but none looked like a registration step" and the call was reported as
    // a registration failure with no form anywhere in sight. Four calls. "Listen to the live
    // webcast" and "Enter the event room" fail the same way.
    //
    // 3 puts it below an explicit Register or a submit-worded CTA, which are better bets when a
    // page offers both, and above a bare unlabelled submit button, which is a guess.
    const score = /continue\s+without|guest/i.test(text)
      ? 6
      : /register|registration/i.test(text)
        ? 5
        : /submit|continue|join|enter|watch now|listen now|access|attend/i.test(text)
          ? 4
          : entryWorded
            ? 3
            : // Below every worded CTA and above a bare submit: a step-advance is the right move
              // only when nothing more explicit is on offer.
              allowSubmitFallback && STEP_ADVANCE_PATTERN.test(text)
              ? 2.5
              : type === 'submit'
                ? 2
                : 0;
    // A link only qualifies on explicit entry wording. Without this, "Contact Investor
    // Relations" or a footer link would become a candidate on almost every page.
    if (isPlainAnchor && !entryWorded) continue;
    if (!score || (registrationOnly && !entryWorded)) continue;
    const stepAdvance = allowSubmitFallback && STEP_ADVANCE_PATTERN.test(text);
    if (
      !CTA_BUTTON_PATTERN.test(text) &&
      !entryWorded &&
      !stepAdvance &&
      !(allowSubmitFallback && type === 'submit')
    ) {
      continue;
    }
    candidates.push({ btn, text, score, entryWorded, isSubmit: type === 'submit' });
  }
  // On a tie, a real submit button beats a link-styled control with the same wording. The two
  // are routinely worded identically - "Register" the submit, "Already Registered?" the link -
  // and before this the winner was decided by DOM order, which is not a signal about anything.
  candidates.sort((a, b) => b.score - a.score || Number(b.isSubmit) - Number(a.isSubmit));
  for (const { btn, text, entryWorded } of candidates) {
    // The click itself is bounded inside clickAndAdoptPopup. Playwright's default is 30s, and
    // it spends all of it retrying a merely-disabled button - the normal state of Zoom's
    // "Join" before a name is typed. That ran under the pipeline lock, so every later call in
    // the window queued behind it.
    const result = await clickAndAdoptPopup(page, btn, text, logger);
    if (result.clicked) {
      // Logged because its absence is what made webinar.net hard to diagnose: the fields were
      // filled, the consent was answered, the gate stayed up, and nothing in the log said
      // whether a button had been pressed at all. "Filled but never submitted" and "submitted
      // and rejected" need completely different fixes and looked identical.
      logger.info(`Clicked "${text}".`);
      return { clicked: true, page: result.page, clickedText: text, entryWorded };
    }
  }
  return { clicked: false, page, clickedText: null, entryWorded: false };
}

// "Is a gate still blocking us?" - the answer gates the whole call, so it must only count
// evidence that plausibly belongs to a registration form. Site chrome and unrelated inputs are
// excluded for the reasons documented on FURNITURE_SELECTOR: counting them reported a gate on
// pages that were already joinable, which failed the call outright.
async function hasPendingRegistration(page, clearedEntryButtons = new Set()) {
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
      if (!REGISTRATION_BUTTON_PATTERN.test(text) && !ENTRY_BUTTON_PATTERN.test(text)) continue;
      // We already clicked this one and it worked; its lingering presence is cosmetic.
      if (clearedEntryButtons.has(text)) continue;
      if (IRRELEVANT_BUTTON_PATTERN.test(text)) continue;
      if (NATIVE_APP_PATTERN.test(text) || STALE_BUTTON_PATTERN.test(text)) continue;
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

// A challenge we have no way to satisfy. Detected structurally (widget markup) rather than by
// wording, because the visible text is localised and often absent until interaction. This does
// not attempt to solve anything - the point is to fail LOUDLY. Before this, a reCAPTCHA-gated
// registration filled its fields, submitted nothing, and the still-visible gate page was
// recorded as though it were the call.
const CHALLENGE_SELECTOR = [
  '.g-recaptcha',
  '#g-recaptcha',
  '[data-sitekey]',
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  'iframe[title*="challenge" i]',
  '.h-captcha',
  '#cf-challenge-running',
  '[class*="turnstile"]',
].join(', ');

async function hasUnsolvableChallenge(page) {
  for (const frame of page.frames()) {
    const found = await frame
      .evaluate((selector) => {
        for (const el of document.querySelectorAll(selector)) {
          const r = el.getBoundingClientRect();
          // A zero-size node is an invisible/score-based widget that needs no interaction;
          // only a rendered challenge actually blocks the form.
          if (r.width > 20 && r.height > 20) return true;
        }
        return false;
      }, CHALLENGE_SELECTOR)
      .catch(() => false);
    if (found) return true;
  }
  return false;
}

// True when any frame says we are waiting for the call to begin rather than being blocked.
async function pageShowsLegitimateWait(page) {
  for (const frame of page.frames()) {
    const waiting = await frame
      .evaluate(
        (source) => new RegExp(source, 'i').test((document.body && document.body.innerText) || ''),
        LEGITIMATE_WAIT_PATTERN.source
      )
      .catch(() => false);
    if (waiting) return true;
  }
  return false;
}

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
async function fillRegistrationForm(page, identity, logger, onPageChanged, strategy) {
  // Later attempts are more patient and less fussy - see retryStrategy.js. A first attempt
  // uses exactly the values that were hardcoded here before.
  const maxSteps = (strategy && strategy.maxFormSteps) || 4;
  const alwaysAllowFurniture = Boolean(strategy && strategy.allowFurniture);
  if (strategy && strategy.attempt > 1) {
    logger.info(`Filling with a wider search (attempt ${strategy.attempt}: ${strategy.label}).`);
  }
  // Registration forms/buttons often render in client-side after domcontentloaded, so an
  // immediate query can race the page and find nothing even when a gate exists.
  await waitForRegistrationSurface(page);
  await dismissCookieOverlays(page, logger);

  let foundAny = false;
  let lastAction = false;
  // Entry CTAs we successfully clicked. Some providers reveal the player WITHOUT removing the
  // button that revealed it; the pending check would then see its own successful click as
  // proof of an unresolved gate and fail a call that had actually been joined. Registration-
  // worded buttons are deliberately NOT remembered - if a "Register" button is still there, a
  // real form gate probably is too, and that must stay a loud failure.
  const clearedEntryButtons = new Set();
  for (let step = 0; step < maxSteps; step++) {
    // Stop the moment the provider says we are in. Without this the next step reads the
    // confirmation page as another form to work on, and clicks whatever button it offers -
    // which on q4inc is "Create Account", leading off the event entirely. Registering and then
    // navigating away is worse than failing to register: it looks like progress.
    if (step > 0 && (await hasRegistrationSuccess(page).catch(() => false))) {
      logger.info('The provider confirmed the registration; leaving the page alone.');
      break;
    }

    // A waiting room is a destination, not an obstacle. Zoom's says "Waiting for host to start
    // the webinar" and offers a "Host Sign in" button; carrying on past that is how a capture
    // that had already joined ended up on Zoom's login page. Anything that looks like a lobby
    // is where we want to be, and the right move is to stop touching the page.
    if (step > 0 && (await pageShowsLegitimateWait(page).catch(() => false))) {
      logger.info('The page is in a waiting room; we are through the gate. Leaving it alone.');
      break;
    }
    let acted = false;
    for (const frame of registrationFrames(page)) {
      const fields = await frame.$$('input:visible, select:visible, textarea:visible').catch(() => []);
      const buttons = await frame.$$(CLICKABLE_SELECTOR).catch(() => []);
      if (!fields.length && !buttons.length) continue;
      foundAny = true;
      // The furniture fallback is only for a first-pass gate that genuinely lives in site
      // chrome. Once we have acted, a remaining chrome-only field is page furniture (a footer
      // newsletter) that happens to look identity-shaped - filling it subscribes the dummy
      // identity and widens the set of buttons the click step will then accept.
      // The furniture fallback is normally reserved for a first pass, where a gate genuinely
      // living in a footer is plausible. Once precision has failed it is worth trying anyway.
      let filledCount = await fillVisibleFields(
        frame,
        identity,
        logger,
        alwaysAllowFurniture || (step === 0 && !lastAction)
      );
      // Only once the identity fields are in: an unmatched dropdown is answered as a last
      // resort, never in preference to a field we actually understand.
      filledCount += await fillUnmatchedSelects(frame, identity, logger);
      filledCount += await answerCustomComboboxes(frame, identity, logger);
      await checkRequiredConsent(frame, logger);
      await answerConsentRadios(frame, logger);
      await tickWaiverCheckboxes(frame, logger);
      // Last, so it only ever sees what everything else declined to answer.
      await fillRequiredUnmatched(frame, identity, logger);
      // `lastAction` matters as much as `filledCount` here, and only on a form split across
      // steps. The second step often has NOTHING to type - just a confirmation and a button -
      // so filledCount is 0 there, which used to restrict the click to registration-worded
      // buttons only. A step-two button reading "Submit" or "Continue" is neither, so the form
      // was abandoned one click from done, with every field correctly filled behind it.
      //
      // Having already typed into this form is what makes the difference. On a page where
      // nothing has ever been filled the restriction still holds, which is what stops a random
      // CTA being clicked on a page that has no gate at all.
      const committed = filledCount > 0 || lastAction;
      const outcome = await clickFirstMatchingButton(page, frame, logger, committed, !committed);
      if (outcome.clicked && outcome.entryWorded && !REGISTRATION_BUTTON_PATTERN.test(outcome.clickedText)) {
        clearedEntryButtons.add(outcome.clickedText);
      }
      if (filledCount || outcome.clicked) {
        acted = true;
        lastAction = true;
      }
      // Adopting a popup invalidates every handle from the old page, so the frame loop must
      // stop here and the next step re-query against the tab we now hold.
      if (outcome.page !== page) {
        page = outcome.page;
        // Reported the instant it happens, not only on the way out. If this function throws
        // after adopting a popup, the caller is otherwise still holding the ORIGINAL page -
        // which clickAndAdoptPopup has already closed - so its cleanup closes a dead handle and
        // the adopted tab is orphaned, live and unwatched, for the rest of the run.
        if (onPageChanged) onPageChanged(page);
        break;
      }
    }
    if (!acted) break;
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(800);
  }
  if (!foundAny) logger.info('No visible form fields or registration button found (probably no registration gate).');
  // This case previously logged NOTHING: foundAny suppressed the message above, and having
  // acted on nothing produced no message of its own. That is precisely what a Zoom lobby looks
  // like - buttons present, none of them registration-shaped - so the most informative line
  // available about the page was the one line never written.
  else if (!lastAction) logger.info('Controls present but none looked like a registration step; nothing filled or clicked.');
  // An error message outranks a success message (some pages show both, e.g. "registered" plus
  // "this email is not accepted"), so the error is checked first and wins.
  const error = await findRegistrationError(page);
  let pending = foundAny && (await hasPendingRegistration(page, clearedEntryButtons));
  if (pending && !error && (await hasRegistrationSuccess(page))) {
    logger.info('Registration acknowledged by the page; treating the gate as cleared.');
    pending = false;
  }
  // A rendered challenge means the gate cannot be cleared by us, whatever the field checks
  // conclude. Asserted after the success check so a page that already let us through (and
  // merely carries a widget elsewhere) is not failed retroactively.
  if (!pending && !(await hasRegistrationSuccess(page)) && (await hasUnsolvableChallenge(page))) {
    logger.warn('A CAPTCHA/anti-bot challenge is on screen; this gate cannot be cleared automatically.');
    pending = true;
  }
  if (error) logger.warn(`Registration page reports an error: ${error}`);
  if (lastAction && pending) logger.warn('Registration may still be incomplete after the available steps.');
  // `page` is returned because it may no longer be the one passed in - see clickAndAdoptPopup.
  return { foundAny, pending, error: pending ? error : null, page };
}

// Diagnostic only: what the filler SEES on a page, without touching it. Reading a form the way
// the matcher reads it is the fastest way to find out why a real registration failed - guessing
// from an error message costs far more. Used by scripts/diagnostics/diag-form-fields.js.
async function inspectFields(page) {
  const rows = [];
  for (const frame of page.frames()) {
    const fields = await frame.$$('input:visible, select:visible, textarea:visible').catch(() => []);
    for (const el of fields) {
      const type = ((await el.getAttribute('type')) || 'text').toLowerCase();
      if (['hidden', 'submit', 'button'].includes(type)) continue;
      const description = await describeField(el);
      rows.push({
        type,
        description: (description || '').replace(/\s+/g, ' ').trim(),
        matchedKey: matchField(description) || null,
        required: await el.evaluate((n) => n.required || n.getAttribute('aria-required') === 'true').catch(() => false),
        value: (await el.inputValue().catch(() => '')) || '',
      });
    }
  }
  return rows;
}

module.exports = { fillRegistrationForm, matchField, inspectFields };
