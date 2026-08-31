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


// Hosts that are never a webcast, whatever the path says.
//
// kalkine.com.au is a news aggregator. The portal's link for nine calls points at an ARTICLE
// announcing that results are coming - "Accent Group to Release FY26 Full-Year Financial
// Results" - and the page carries no webcast link at all: stock tickers, a "Download Free
// Report" lead magnet, and nothing else.
//
// Left alone, this is worse than a missed call. The resolver follows a navigational link into
// kalkine.com.au/get-three-stocks, which is a lead-capture form with First Name, Last Name,
// Email and Mobile - so the filler fills it in and submits it. We are not recording anything and
// we are handing an address to a stock-tips funnel, four times per call.
//
// Refusing by host is right here rather than trying to find a real link, because there is none
// to find. These rows need a better link in the portal, and naming that plainly in the ledger is
// the most useful thing this can do.
const NOT_A_WEBCAST_HOST = [
  {
    provider: 'kalkine.com.au',
    match: /(?:^|\.)kalkine\.com(?:\.au)?$/i,
    why: 'a news aggregator: the link is an article announcing the results, and the page carries no webcast. Following it leads to a lead-capture form',
  },
];

// Returns a reason when the link's HOST can never carry a webcast, and null otherwise.
function notAWebcastReason(url) {
  let host;
  try {
    host = new URL(String(url || '')).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
  for (const rule of NOT_A_WEBCAST_HOST) {
    if (rule.match.test(host)) return `${rule.provider} is ${rule.why}`;
  }
  return null;
}

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

module.exports = {
  rewriteToWebcastUrl,
  telephoneOnlyReason,
  notAWebcastReason,
  REWRITES,
  TELEPHONE_ONLY,
  NOT_A_WEBCAST_HOST,
};
