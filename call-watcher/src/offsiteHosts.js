const NEVER_A_WEBCAST_HOST =
  /(^|\.)(facebook|fb|twitter|x|instagram|linkedin|tiktok|reddit|pinterest|threads|whatsapp|telegram|t)\.(com|me|co)$/i;

const IDENTITY_HOST =
  /^(accounts\.google\.com|appleid\.apple\.com|login\.microsoftonline\.com|login\.live\.com|signin\.aws\.amazon\.com|id\.atlassian\.com)$/i;

function isSocialHost(url) {
  try {
    return NEVER_A_WEBCAST_HOST.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

// A vendor help centre is never the call. CARD.L 2027Q2 spent its third attempt on
// support.zoom.com/hc/en/billing-and-account, reached from a footer link on Zoom's own
// registration page - neither social nor an identity provider, so nothing caught it.
const VENDOR_HELP_HOST = /^(?:support|help|docs|status|community)\./i;

function isOffsiteDeadEnd(currentUrl, candidateUrl) {
  try {
    const here = new URL(currentUrl).hostname;
    const there = new URL(candidateUrl, currentUrl).hostname;
    if (here === there) return false;
    return NEVER_A_WEBCAST_HOST.test(there) || IDENTITY_HOST.test(there) || VENDOR_HELP_HOST.test(there);
  } catch {
    return false;
  }
}

module.exports = { NEVER_A_WEBCAST_HOST, IDENTITY_HOST, VENDOR_HELP_HOST, isSocialHost, isOffsiteDeadEnd };
