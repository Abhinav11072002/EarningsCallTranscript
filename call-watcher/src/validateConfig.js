// Checks the config at startup instead of letting a mistake surface hours later as behaviour
// nobody ordered.
//
// Every numeric setting in this project is read as `config.x ?? default`, which means a typo'd
// key is not an error - it is silently the default. Rename `thresholdMinutes` to
// `treshholdMinutes` and the watcher starts perfectly, reports nothing unusual, and quietly
// uses a different window than the one written in the file. The same goes for a value that is
// the right key but the wrong shape: `"15"` instead of `15` mostly works, until it does not.
//
// Two severities, and the difference matters:
//   - errors  : the run cannot be trusted, so refuse to start
//   - warnings: suspicious but survivable, so say so and continue
//
// An unknown key is deliberately only a WARNING. Refusing to start over one would make this
// check itself a hazard the first time someone adds a setting for a branch or an experiment.

const SPEC = {
  portalUrl: { type: 'url', required: true },
  cdpUrl: { type: 'url', required: true },
  pollIntervalMs: { type: 'int', min: 1000, max: 600000 },
  thresholdMinutes: { type: 'number', min: 0, max: 240 },
  retryWindowMinutes: { type: 'number', min: 0, max: 1440 },
  maxAttempts: { type: 'int', min: 1, max: 50 },
  popupTimeoutMs: { type: 'int', min: 1000, max: 120000 },
  streamConfirmTimeoutMs: { type: 'int', min: 1000, max: 120000 },
  cdpCommandTimeoutMs: { type: 'int', min: 1000, max: 120000 },
  shortcutTimeoutMs: { type: 'int', min: 1000, max: 120000 },
  lateStartGraceMinutes: { type: 'number', min: 0, max: 120 },
  reacquireGraceMinutes: { type: 'number', min: 0, max: 600 },
  reacquireWithinMinutesOfStart: { type: 'number', min: 0, max: 60 },
  absentObservationsBeforeComplete: { type: 'int', min: 1, max: 20 },
  maxCallTabMinutes: { type: 'int', min: 1, max: 1440 },
  hardMaxCallTabMinutes: { type: 'int', min: 1, max: 1440 },
  callTabEndedGraceMinutes: { type: 'int', min: 0, max: 240 },
  closeTabMinutesPastCallStart: { type: 'int', min: 5, max: 480 },
  stateRecordTtlDays: { type: 'int', min: 1, max: 365 },
  logRetentionDays: { type: 'int', min: 1, max: 365 },
  extensionShortcutSendKeys: { type: 'string', required: true },
  extensionId: { type: 'extensionId', nullable: true },
  dummyIdentity: { type: 'identity', required: true },
  knownDirectProviderDomains: { type: 'domains', required: true },
  maxConcurrentPreparations: { type: 'int', min: 1, max: 20 },
  prepareDeadlineMs: { type: 'int', min: 10000, max: 600000 },
  triggerDeadlineMs: { type: 'int', min: 10000, max: 600000 },
  requirePageRelevance: { type: 'boolean' },
  singleInstance: { type: 'boolean' },
};

const IDENTITY_FIELDS = ['firstName', 'lastName', 'email', 'phone', 'company', 'country'];

function checkValue(key, value, rule, errors, warnings) {
  const bad = (msg) => errors.push(`${key}: ${msg}`);

  switch (rule.type) {
    case 'url':
      if (typeof value !== 'string') return bad(`must be a URL string, got ${typeof value}`);
      try {
        new URL(value);
      } catch {
        bad(`is not a valid URL ("${value}")`);
      }
      return;

    case 'string':
      if (typeof value !== 'string' || !value.trim()) bad('must be a non-empty string');
      return;

    case 'boolean':
      if (typeof value !== 'boolean') bad(`must be true or false, got ${JSON.stringify(value)}`);
      return;

    case 'int':
    case 'number': {
      // A quoted number is the classic JSON slip. It survives `Number(...)` everywhere in the
      // codebase, so it would work - which is precisely why it is worth flagging rather than
      // leaving as a trap for the one place that ever compares without coercing.
      if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
        warnings.push(`${key}: is the string "${value}" rather than the number ${Number(value)} - quote removed on read, but fix it`);
        value = Number(value);
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) return bad(`must be a number, got ${JSON.stringify(value)}`);
      if (rule.type === 'int' && !Number.isInteger(value)) return bad(`must be a whole number, got ${value}`);
      if (rule.min !== undefined && value < rule.min) return bad(`is ${value}, below the minimum ${rule.min}`);
      if (rule.max !== undefined && value > rule.max) return bad(`is ${value}, above the maximum ${rule.max}`);
      return;
    }

    case 'extensionId':
      if (value === null || value === undefined) return; // resolved from the service worker instead
      // Chrome extension IDs are exactly 32 characters drawn from a-p. Anything else is a
      // copy/paste accident that would otherwise fail much later, at the trigger step.
      if (typeof value !== 'string' || !/^[a-p]{32}$/.test(value)) {
        bad(`does not look like a Chrome extension ID (expected 32 letters a-p, got ${JSON.stringify(value)})`);
      }
      return;

    case 'identity': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return bad('must be an object');
      const missing = IDENTITY_FIELDS.filter((f) => !value[f] || !String(value[f]).trim());
      // Not fatal: a form asking only for a name still registers fine without a phone number.
      if (missing.length) warnings.push(`dummyIdentity: no value for ${missing.join(', ')} - forms asking for those cannot be completed`);
      if (value.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(value.email))) {
        bad(`dummyIdentity.email does not look like an email address ("${value.email}")`);
      }
      return;
    }

    case 'domains': {
      if (!Array.isArray(value) || !value.length) return bad('must be a non-empty array of domains');
      for (const d of value) {
        if (typeof d !== 'string' || !d.trim()) return bad(`contains a non-string entry (${JSON.stringify(d)})`);
        // A scheme or path here silently never matches: hostnameMatches compares hostnames.
        if (/[/:]/.test(d)) bad(`entry "${d}" should be a bare hostname, not a URL - it can never match as written`);
      }
      return;
    }

    default:
      return;
  }
}

function validateConfig(config) {
  const errors = [];
  const warnings = [];

  for (const [key, rule] of Object.entries(SPEC)) {
    const present = Object.prototype.hasOwnProperty.call(config, key);
    if (!present) {
      if (rule.required) errors.push(`${key}: is required but missing`);
      continue;
    }
    const value = config[key];
    if (value === null && rule.nullable) continue;
    checkValue(key, value, rule, errors, warnings);
  }

  for (const key of Object.keys(config)) {
    if (!Object.prototype.hasOwnProperty.call(SPEC, key)) {
      warnings.push(`${key}: is not a setting this tool reads - a typo here silently leaves the real setting at its default`);
    }
  }

  // Cross-field checks: individually valid, together nonsensical.
  const threshold = Number(config.thresholdMinutes);
  const prepare = Number(config.prepareDeadlineMs);
  const trigger = Number(config.triggerDeadlineMs);
  if (Number.isFinite(threshold) && Number.isFinite(prepare) && Number.isFinite(trigger)) {
    // One call must comfortably fit inside the window, or the first call dispatched can eat it.
    if (prepare + trigger > threshold * 60000) {
      warnings.push(
        `prepareDeadlineMs + triggerDeadlineMs (${(prepare + trigger) / 1000}s) exceeds the whole ` +
          `${threshold}-minute window - one slow call could consume it and starve every call behind it`
      );
    }
  }
  const poll = Number(config.pollIntervalMs);
  if (Number.isFinite(poll) && Number.isFinite(threshold) && poll > (threshold * 60000) / 2) {
    warnings.push(
      `pollIntervalMs (${poll}ms) is more than half the ${threshold}-minute window - a call could ` +
        'enter and pass through the window between two polls and never be seen'
    );
  }

  return { ok: errors.length === 0, errors, warnings };
}

module.exports = { validateConfig, SPEC };
