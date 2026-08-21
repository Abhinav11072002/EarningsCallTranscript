const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const LOCAL_CONFIG_PATH = path.join(__dirname, '..', 'config.local.json');

// Loads config.json, then shallow-merges an optional (gitignored) config.local.json over it.
//
// This exists because some settings are inherently machine-specific and MUST NOT be shared
// between machines via git - most importantly `extensionId`: Chrome derives an unpacked
// extension's ID from its install path, so every machine/profile gets a different one.
// With the ID committed in config.json, two machines pushing to the same repo overwrite each
// other's value on every pull, silently breaking the extension-trigger step until someone
// notices and edits it back.
//
// Shallow merge is deliberate: every key that realistically needs a local override
// (extensionId, cdpUrl, thresholdMinutes for testing) is a top-level scalar. Overriding a
// nested object like dummyIdentity means providing the whole object, which is the clearer
// behavior anyway - a half-merged identity would be more confusing than an explicit one.
function loadConfig() {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  if (!fs.existsSync(LOCAL_CONFIG_PATH)) return config;

  let local;
  try {
    local = JSON.parse(fs.readFileSync(LOCAL_CONFIG_PATH, 'utf8'));
  } catch (err) {
    // A malformed override is worth surfacing loudly rather than silently ignoring - otherwise
    // the machine quietly runs with the wrong (committed) extensionId and fails later on in a
    // much less obvious way.
    throw new Error(`config.local.json exists but could not be parsed: ${err.message}`);
  }
  return { ...config, ...local };
}

module.exports = { loadConfig, CONFIG_PATH, LOCAL_CONFIG_PATH };
