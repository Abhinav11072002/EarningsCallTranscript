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

function isOffsiteAuthOrSocial(currentUrl, candidateUrl) {
  try {
    const here = new URL(currentUrl).hostname;
    const there = new URL(candidateUrl, currentUrl).hostname;
    if (here === there) return false;
    return NEVER_A_WEBCAST_HOST.test(there) || IDENTITY_HOST.test(there);
  } catch {
    return false;
  }
}

module.exports = { NEVER_A_WEBCAST_HOST, IDENTITY_HOST, isSocialHost, isOffsiteAuthOrSocial };
