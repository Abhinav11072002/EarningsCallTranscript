// What we know about specific providers' URLs, before a browser is ever opened.
//
// Two kinds of knowledge, both cheap and both learned the same way: by opening a failing call's
// link by hand and reading the page.
//
//   REWRITES        the link the portal gives is the wrong kind of link for the same event,
//                   and the right one is derivable from it
//   TELEPHONE_ONLY  the link can never carry browser audio, so trying is a waste of the
//                   pipeline lock that other calls in the same window are queued behind
//
// This is deliberately a table rather than logic. Adding a provider is one entry with a reason
// attached; nothing else in the system needs to change, and the reason is what makes the entry
// reviewable later when the provider changes its URLs.

const REWRITES = [
  {
    provider: 'events.q4inc.com',
    // Seven calls over three days, every one of them refused with "the page has no audio or
    // video player" - and the refusal was correct. events.q4inc.com/analyst/<id> is the
    // registration for the analyst TELEPHONE line: it asks for "the phone number you will call
    // in from" and hands back a dial-in and a PIN. There is no stream on that page at all.
    //
    // The listen-only webcast is the same event id under /attendee/, and it offers "Continue
    // without a Q4 account", which the form filler already scores highest. So the whole failure
    // was the kind of link, not anything the filler did.
    match: /^(https?:\/\/events\.q4inc\.com)\/analyst\/(\d+)(.*)$/i,
    rewrite: (m) => `${m[1]}/attendee/${m[2]}${m[3]}`,
    why: 'the /analyst/ link registers for the telephone Q&A line, which has no browser stream; /attendee/ is the listen-only webcast for the same event',
  },
];

// Providers that only ever offer a telephone number. Failing immediately with a clear reason
// beats four attempts that each open a tab, fill a form and then discover there is nothing to
// record - those attempts run under the pipeline lock, so they delay calls that could succeed.
const TELEPHONE_ONLY = [
  {
    provider: 'Chorus Call Diamond Pass',
    match: /(?:s\d+\.c-conf\.com|choruscall\.com)\/diamondpass|dpregister\.com\/DiamondPassRegistration/i,
    why: 'Diamond Pass issues a dial-in number and PIN; it has no browser stream',
  },
];

// Returns the URL to actually open, and says why when it differs.
function rewriteToWebcastUrl(url) {
  const target = String(url || '');
  for (const rule of REWRITES) {
    const m = target.match(rule.match);
    if (!m) continue;
    const rewritten = rule.rewrite(m);
    if (rewritten === target) continue;
    return { url: rewritten, changed: true, provider: rule.provider, why: rule.why };
  }
  return { url: target, changed: false };
}

// Returns a reason when the link cannot carry browser audio, and null otherwise.
function telephoneOnlyReason(url) {
  const target = String(url || '');
  for (const rule of TELEPHONE_ONLY) {
    if (rule.match.test(target)) return `${rule.provider}: ${rule.why}`;
  }
  return null;
}

module.exports = { rewriteToWebcastUrl, telephoneOnlyReason, REWRITES, TELEPHONE_ONLY };
