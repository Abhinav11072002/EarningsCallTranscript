// Builds registration pages from a grammar of shapes we have actually met in production.
//
// The gauntlet has one hand-written fixture per provider that defeated us. That is the right
// way to lock in a specific bug, and the wrong way to find the next one: every fixture tests a
// combination someone already thought of. This generates the combinations nobody thought of -
// a hyphenated id with a left-hand label and a waiver checkbox and a "NEXT" button - by taking
// the axes independently and crossing them.
//
// Every page it produces is one a competent person could complete in a few seconds. If the
// filler cannot, that is a real gap, not an unfair test.
//
// Deterministic: the same seed gives the same page, so a failure reported as "case 417" can be
// reproduced exactly by asking for case 417 again.

// Small xorshift PRNG. Node's Math.random cannot be seeded, and a fuzz suite that cannot
// reproduce its own failures is not much use.
function makeRandom(seed) {
  let state = (seed | 0) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 100000) / 100000;
  };
}

const pick = (random, list) => list[Math.floor(random() * list.length) % list.length];
const chance = (random, probability) => random() < probability;

// ---------------------------------------------------------------- the axes
//
// Each of these is a shape observed on a real provider. The comment names where.

// How a field's name is written. Semantic is the easy case; the rest are all real.
const ID_STYLES = {
  semantic: (key) => key.toLowerCase(),
  hyphenated: (key) => `analyst-${key.replace(/([A-Z])/g, '-$1').toLowerCase()}`, // q4inc
  underscored: (key) => `question_${key.replace(/([A-Z])/g, '_$1').toLowerCase()}`, // Zoom
  numeric: (key, index) => String(43200 + index), // openbriefing
  hashed: (key, index) => `f_${(index * 7919).toString(16)}`, // lumiengage
};

// How the label is attached to its field, or not attached at all.
const LABEL_STYLES = ['for', 'wrapping', 'above', 'left', 'floating', 'aria', 'placeholder'];

// How the form says a field is required.
const REQUIRED_MARKERS = ['none', 'asterisk', 'attribute', 'class', 'word'];

const FIELDS = [
  { key: 'firstName', label: 'First Name' },
  { key: 'lastName', label: 'Last Name' },
  { key: 'email', label: 'Email Address' },
  { key: 'company', label: 'Company' },
  { key: 'phone', label: 'Phone Number' },
  { key: 'jobTitle', label: 'Job Title' },
];

// Wordings that must lead INTO the call.
const ENTRY_WORDINGS = [
  'Register',
  'Submit',
  'Register for this Event',
  'Join the webcast',
  'Enter the event',
  'Continue',
  'Watch the webcast',
];

// Controls that must never be clicked, and why. Each is marked data-forbidden, so a single
// wrong click fails the case loudly instead of quietly changing the outcome.
const DECOYS = [
  { text: 'Join from Zoom Workplace app', why: 'native app handler steals the foreground' },
  { text: 'Launch Meeting', why: 'same, and says nothing about an app' },
  { text: 'Listen to the replay', why: 'a recording of a call that already happened' },
  { text: 'Watch the on-demand archive', why: 'same' },
  { text: 'Already Registered?', why: 'a mode switch that discards the form' },
  { text: 'Create Account', why: 'an upsell; we cannot verify a mailbox' },
  { text: 'Host Sign in', why: 'for the host, not an attendee' },
  { text: 'Download the slides', why: 'not the call' },
  { text: 'Subscribe to our newsletter', why: 'a real side effect on a real address' },
];

function labelMarkup(style, id, text, required, marker) {
  const star = required && marker === 'asterisk' ? '<span class="required">*</span>' : '';
  const word = required && marker === 'word' ? ' (required)' : '';
  const full = `${text}${word}`;
  switch (style) {
    case 'for':
      return { before: `${star}<label for="${id}">${full}</label>`, after: '', attrs: '' };
    case 'wrapping':
      return { before: `<label>${star}${full}`, after: '</label>', attrs: '' };
    case 'above':
      return { before: `<div>${star}<span class="lbl">${full}</span></div>`, after: '', attrs: '' };
    case 'left':
      // Two-column table row: the label sits BESIDE the field, which pure vertical geometry
      // cannot see at all.
      return { before: null, after: null, attrs: '', table: full, star };
    case 'floating':
      return {
        before: `<div style="position:relative;height:44px;width:320px">${star}<span class="lbl" style="position:absolute;left:8px;top:12px;color:#888">${full}</span>`,
        after: '</div>',
        attrs: 'style="position:absolute;left:0;top:8px;width:320px;height:28px"',
      };
    case 'aria':
      return { before: star, after: '', attrs: `aria-label="${full}"` };
    case 'placeholder':
      return { before: star, after: '', attrs: `placeholder="${full}"` };
    default:
      return { before: `<label for="${id}">${full}</label>`, after: '', attrs: '' };
  }
}

function buildPage(seed, identity) {
  const random = makeRandom(seed);
  const idStyleName = pick(random, Object.keys(ID_STYLES));
  const idFor = ID_STYLES[idStyleName];
  const marker = pick(random, REQUIRED_MARKERS);
  const labelStyle = pick(random, LABEL_STYLES);

  // Between two and all six identity fields, always including a name and an email - every real
  // registration asks for at least that much.
  const count = 2 + Math.floor(random() * (FIELDS.length - 1));
  const chosen = FIELDS.slice(0, count);

  const parts = [];
  const expectations = [];
  const tableRows = [];

  chosen.forEach((field, index) => {
    const id = idFor(field.key, index);
    const required = marker !== 'none' && chance(random, 0.8);
    const label = labelMarkup(labelStyle, id, field.label, required, marker);
    const requiredAttr = required && marker === 'attribute' ? ' required' : '';
    const requiredClass = required && marker === 'class' ? ' class="required-field"' : '';
    const input = `<input type="text" id="${id}" name="${id}"${requiredAttr}${requiredClass} ${label.attrs} data-expect="${field.key}">`;

    if (labelStyle === 'left') {
      tableRows.push(
        `<tr><td style="width:170px">${label.star}<span class="lbl">${label.table}</span></td><td>${input}</td></tr>`
      );
    } else {
      parts.push(`${label.before}${input}${label.after}`);
    }
    expectations.push({ id, key: field.key, required });
  });

  if (tableRows.length) parts.unshift(`<table>${tableRows.join('')}</table>`);

  // ---------------------------------------------------------------- optional obstacles
  const obstacles = [];

  // A country dropdown whose wording differs from ours - "United States" against "USA".
  if (chance(random, 0.3)) {
    obstacles.push(`<label for="country">Country *</label>
      <select id="country" name="country" required>
        <option value="">Select a country</option>
        <option>United Kingdom</option><option>United States</option><option>Canada</option>
      </select>`);
  }

  // A dropdown that means nothing to us, where "Other" is the only honest answer.
  if (chance(random, 0.3)) {
    obstacles.push(`<label for="industry">Industry Affiliation *</label>
      <select id="industry" name="industry" required>
        <option value="">Please select</option>
        <option data-forbidden="true">Buy-Side Analyst</option>
        <option data-forbidden="true">Sell-Side Analyst</option>
        <option>Other</option>
      </select>`);
  }

  // The same question as a custom combobox, which has no <select> anywhere.
  if (chance(random, 0.22)) {
    obstacles.push(`<span id="aff-label">Affiliation *</span>
      <button type="button" role="combobox" id="aff" aria-labelledby="aff-label" aria-haspopup="listbox">Select an option</button>
      <ul id="aff-list" role="listbox" style="display:none">
        <li role="option" data-forbidden="true">Media</li>
        <li role="option" data-forbidden="true">Employee</li>
        <li role="option">Other</li>
      </ul>`);
  }

  // Consent, sometimes with the input hidden behind its own styled label.
  const consentIntercepted = chance(random, 0.5);
  if (chance(random, 0.55)) {
    obstacles.push(
      consentIntercepted
        ? `<div style="position:relative;height:26px">
             <input type="checkbox" id="terms" required style="position:absolute;left:0;top:0;opacity:0.01;width:16px;height:16px">
             <label id="terms-label" for="terms" style="position:absolute;left:0;top:0;width:300px;height:24px">I accept the terms of use and privacy policy *</label>
           </div>`
        : `<label><input type="checkbox" id="terms" required> I accept the terms of use and privacy policy *</label>`
    );
  }

  // A Yes/No consent pair, where choosing "No" is worse than choosing nothing.
  const hasConsentRadio = chance(random, 0.25);
  if (hasConsentRadio) {
    obstacles.push(`<fieldset><legend>Data processing *</legend>
      <label><input type="radio" name="dp" id="dp-yes"> Yes. I understand my information will be processed and shared with the host.</label>
      <label><input type="radio" name="dp" id="dp-no" data-forbidden="true"> No. I do not want my information processed.</label>
      </fieldset>`);
  }

  // The trap that made q4inc unsolvable: a required field with no answerable value, and a
  // checkbox that waives it.
  const hasWaiver = chance(random, 0.18);
  if (hasWaiver) {
    obstacles.push(`<div style="position:relative;height:26px">
        <input type="checkbox" id="individual" style="position:absolute;left:0;top:0;opacity:0.01;width:16px;height:16px">
        <label id="individual-label" for="individual" style="position:absolute;left:0;top:0;width:300px;height:24px">I am an individual attendee</label>
      </div>
      <label for="institution">Institution Name *</label>
      <input type="text" id="institution" data-forbidden="true" data-expect="none"
             placeholder="Search for your institution" role="combobox" autocomplete="off">`);
  }

  // A spam trap parked outside the page. Filling it is how a registration gets silently binned.
  if (chance(random, 0.3)) {
    obstacles.push(`<div style="position:absolute;left:-9999px">
      <label for="hp">Email confirm</label><input id="hp" name="email_confirm" data-expect="none">
    </div>`);
  }

  // Furniture that looks fillable: a site search box and a newsletter signup.
  if (chance(random, 0.35)) {
    obstacles.push(`<footer><label for="nl">Newsletter email</label>
      <input id="nl" name="newsletter_email" data-expect="none"></footer>`);
  }

  const decoyCount = Math.floor(random() * 4);
  const decoys = [];
  for (let i = 0; i < decoyCount; i++) {
    const decoy = pick(random, DECOYS);
    decoys.push(`<a href="#decoy" data-forbidden="true" title="${decoy.why}">${decoy.text}</a>`);
  }

  const submitText = pick(random, ENTRY_WORDINGS);
  const twoStep = chance(random, 0.25);
  const behindEntry = chance(random, 0.2);

  const requiredIds = expectations.filter((e) => e.required).map((e) => e.id);
  const gates = [
    ...(obstacles.some((o) => o.includes('id="country"')) ? ['country'] : []),
    ...(obstacles.some((o) => o.includes('id="industry"')) ? ['industry'] : []),
  ];

  return {
    seed,
    shape: { idStyle: idStyleName, labelStyle, marker, twoStep, behindEntry, hasWaiver, hasConsentRadio, decoys: decoyCount },
    expectations,
    html: renderPage({ parts, obstacles, decoys, submitText, twoStep, behindEntry, requiredIds, gates, hasWaiver, hasConsentRadio, seed }),
  };
}

function renderPage(opts) {
  const { parts, obstacles, decoys, submitText, twoStep, behindEntry, requiredIds, gates, hasWaiver, hasConsentRadio, seed } = opts;
  const formInner = [...parts, ...obstacles].join('\n      ');

  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Generated Registration ${seed} - Q2 2026 Earnings Call</title></head>
<body>
  <h1>Acme Corporation Q2 2026 Earnings Conference Call</h1>
  <p>Thursday, 28 August 2026</p>
  ${decoys.join('\n  ')}

  ${behindEntry ? '<button type="button" id="reveal">Register Now</button>' : ''}

  <form id="reg"${behindEntry ? ' style="display:none"' : ''}>
    <div id="step1">
      ${formInner}
    </div>
    ${twoStep ? '<div id="step2" style="display:none"><p>Almost done.</p></div>' : ''}
    <button type="submit" id="submit">${twoStep ? 'NEXT' : submitText}</button>
  </form>

  ${twoStep ? `<form id="reg2" style="display:none"><button type="submit" id="submit2">${submitText}</button></form>` : ''}

  <p id="error" style="display:none"></p>
  <div id="console" style="display:none" data-incall>Webcast console</div>
  <audio id="stream" style="display:none" controls></audio>

  <script>
    const requiredIds = ${JSON.stringify(requiredIds)};
    const gates = ${JSON.stringify(gates)};
    const hasWaiver = ${JSON.stringify(hasWaiver)};
    const hasConsentRadio = ${JSON.stringify(hasConsentRadio)};

    const reveal = document.getElementById('reveal');
    if (reveal) reveal.addEventListener('click', () => {
      reveal.style.display = 'none';
      document.getElementById('reg').style.display = 'block';
    });

    // The custom combobox, if this page has one.
    const combo = document.getElementById('aff');
    const list = document.getElementById('aff-list');
    let comboAnswer = '';
    if (combo) {
      combo.addEventListener('click', () => {
        list.style.display = list.style.display === 'none' ? 'block' : 'none';
      });
      for (const option of list.querySelectorAll('[role=option]')) {
        option.addEventListener('click', () => {
          comboAnswer = option.innerText.trim();
          combo.innerText = comboAnswer;
          list.style.display = 'none';
        });
      }
    }

    // The institution lookup accepts nothing typed into it - the waiver is the only way past.
    const institution = document.getElementById('institution');
    if (institution) institution.addEventListener('blur', (e) => { e.target.value = ''; });

    const missing = () => {
      const out = [];
      for (const id of requiredIds) {
        const el = document.getElementById(id);
        if (el && !el.value.trim()) out.push(id);
      }
      for (const id of gates) {
        const el = document.getElementById(id);
        if (el && !el.value) out.push(id);
      }
      const terms = document.getElementById('terms');
      if (terms && !terms.checked) out.push('terms');
      if (combo && !comboAnswer) out.push('affiliation');
      if (hasConsentRadio && !document.getElementById('dp-yes').checked) out.push('data processing');
      // Institution is required UNLESS the attendee says they represent nobody.
      if (hasWaiver && !document.getElementById('individual').checked) out.push('institution');
      return out;
    };

    const finish = () => {
      document.getElementById('reg').style.display = 'none';
      const second = document.getElementById('reg2');
      if (second) second.style.display = 'none';
      document.getElementById('error').style.display = 'none';
      document.getElementById('console').style.display = 'block';
    };

    document.getElementById('reg').addEventListener('submit', (e) => {
      e.preventDefault();
      const gaps = missing();
      if (gaps.length) {
        const error = document.getElementById('error');
        error.textContent = 'This field is required: ' + gaps.join(', ');
        error.style.display = 'block';
        return;
      }
      const second = document.getElementById('reg2');
      if (second) { document.getElementById('reg').style.display = 'none'; second.style.display = 'block'; return; }
      finish();
    });

    const second = document.getElementById('reg2');
    if (second) second.addEventListener('submit', (e) => { e.preventDefault(); finish(); });
  </script>
</body>
</html>`;
}

module.exports = { buildPage };
