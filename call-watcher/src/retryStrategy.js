// How hard to look, as a function of how many times we have already failed.
//
// Retrying used to mean doing exactly the same thing again. Four attempts were one attempt
// tried four times, and a day's log showed it plainly: every failed call burned all four
// attempts and reported the identical error each time. If the first pass could not find the
// webcast link, or could not get past the form, nothing about the second pass was going to go
// differently.
//
// So each attempt widens the search. The ordering principle is that attempt 1 stays EXACTLY as
// it was - it is what produced 19 good captures in a day, and a broader search is not a better
// one, it is a riskier one. Breadth is what you reach for once precision has already failed:
// looser wording finds more real links and also more wrong ones, so it is worth accepting only
// when the alternative is losing the call entirely.
//
// Attempt 1  precise    known provider domains, tight CTA wording, two hops
// Attempt 2  wider      more nav wording, longer CTA text, an extra hop, footer forms allowed
// Attempt 3  by shape   judge links by their URL as well as their words; try every button
// Attempt 4  last ditch anything that hints at listening, and the most patient form pass

// Deliberately the same defaults the modules used as constants, so attempt 1 is byte-for-byte
// the behaviour that already works.
const BASE = {
  attempt: 1,
  maxHops: 2,
  ctaTextLimit: 60,
  // Nav wording: where the webcast link might be one click deeper.
  navPattern:
    /investor relations|\bevents?\s*(?:&|and)\s*presentations?|\bwebcasts?\b|earnings\s*(?:call|webcast|release)|news\s*(?:&|and)\s*events?/i,
  // Direct CTA wording: the link that IS the call.
  ctaPattern:
    /webcast|listen (live|now|online|to (the )?(call|webcast))|join (the )?(call|webcast)|audio\s*webcast|access\s*(the )?webcast|webcast link/i,
  // When set, links are also judged by their URL path, not only their text. Some providers
  // label the real link with nothing useful ("Click here", an icon, a bare date) while the href
  // says /webcast/ or /event/ outright.
  hrefPattern: null,
  // Let the form filler use fields that live in site chrome. Off first time round because a
  // footer newsletter box looks exactly like a registration field.
  allowFurniture: false,
  // How many fill-then-submit rounds the form filler will do.
  maxFormSteps: 4,
  // Try every plausible button in turn rather than stopping after the best-scoring one clicks.
  tryAllButtons: false,
  label: 'precise',
};

const WIDER = {
  maxHops: 3,
  ctaTextLimit: 90,
  navPattern:
    /investor relations|investors?\b|\bevents?\b|presentations?|\bwebcasts?\b|earnings|results|media|news\s*(?:&|and)\s*events?|financial (?:reports?|information)|quarterly/i,
  ctaPattern:
    /webcast|listen|join|audio|attend|watch|stream|conference call|dial[- ]?in|enter (?:the )?(?:event|call)|click here/i,
  allowFurniture: true,
  maxFormSteps: 6,
  label: 'wider wording',
};

const BY_SHAPE = {
  // Providers put the truth in the URL more reliably than in the link text.
  hrefPattern: /\/(webcast|webinar|event|events|live|stream|broadcast|audio|listen|player|meeting|conference|attendee|register)\b/i,
  tryAllButtons: true,
  label: 'link shape and every button',
};

const LAST_DITCH = {
  ctaTextLimit: 140,
  maxHops: 4,
  ctaPattern:
    /webcast|listen|join|audio|attend|watch|stream|conference|dial|enter|access|participate|live|here|continue|proceed|submit/i,
  maxFormSteps: 8,
  label: 'anything that hints at listening',
};

// Attempts beyond the fourth get the fourth's strategy - there is nothing wider left, and the
// attempt cap stops it there anyway.
function strategyForAttempt(attempt) {
  const n = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 1;
  let strategy = { ...BASE, attempt: n };
  if (n >= 2) strategy = { ...strategy, ...WIDER };
  if (n >= 3) strategy = { ...strategy, ...BY_SHAPE };
  if (n >= 4) strategy = { ...strategy, ...LAST_DITCH };
  // Rebuilt after the spreads so a later tier overriding `label` does not lose the earlier ones.
  strategy.label = describeStrategy(n);
  return strategy;
}

function describeStrategy(n) {
  if (n <= 1) return BASE.label;
  const parts = [WIDER.label];
  if (n >= 3) parts.push(BY_SHAPE.label);
  if (n >= 4) parts.push(LAST_DITCH.label);
  return parts.join(' + ');
}

module.exports = { strategyForAttempt, BASE };
