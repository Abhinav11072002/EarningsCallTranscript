// Makes sure the page is actually PLAYING before we record it.
//
// Joining a call and starting a capture are not the same as audio coming out. Some players sit
// on a poster frame behind a Start button and wait to be pressed - LTRX 2026Q4 said so in as
// many words - and nothing in this project ever pressed one.
//
// That gap explains a loop that looked like three separate problems:
//
//   1. a call is joined and the capture starts correctly
//   2. no audio ever plays, because the player is still waiting to be started
//   3. the extension stops the stream after ten minutes of silence
//   4. the poll loop sees the stream missing, concludes it died, and reacquires
//   5. reacquiring opens a new tab and closes the old one - and back to step 1
//
// Up to four times per call, each round leaving a partial recording of nothing. From the
// outside it looks like the watcher "removing the recording and rejoining", and like it
// endlessly opening tabs for calls it had already captured.
//
// So this runs before the extension is triggered: if there is media and it is paused, start it.
// It is best-effort by design - it warns rather than failing, because plenty of legitimate
// players use WebAudio or a canvas with no media element to inspect, and refusing those would
// lose real calls to fix a problem they do not have.

// Controls that START playback. Word-anchored on purpose: "Replay", "Playback" and "Display"
// all contain "play" and none of them is the button we want - the first would record the wrong
// thing entirely.
const PLAY_TEXT_PATTERN =
  /^\s*(?:▶|▸)?\s*(?:play|start|listen|begin|resume|join audio|play now|start session|start listening|enter (?:the )?(?:call|webcast))\s*$/i;

// Anything that would STOP or leave the call. Checked first, because "Stop" and "Play/Pause"
// toggles sit right next to each other and clicking the wrong one is worse than clicking none.
const NEVER_CLICK_PATTERN = /pause|stop|mute|leave|end|exit|close|replay|playback|rewind|settings|volume|full\s*screen/i;

async function mediaState(page) {
  const states = [];
  for (const frame of page.frames()) {
    const state = await frame
      .evaluate(() => {
        const media = Array.from(document.querySelectorAll('audio, video'));
        const live = media.filter((m) => !m.paused && !m.ended && m.readyState > 0);
        return {
          count: media.length,
          playing: live.length,
          // Playing and audible are not the same thing, and only the second one records.
          audible: live.filter((m) => !m.muted && m.volume > 0).length,
          silent: live.filter((m) => m.muted || m.volume === 0).length,
        };
      })
      .catch(() => null);
    if (state) states.push(state);
  }
  return states.reduce(
    (total, s) => ({
      count: total.count + s.count,
      playing: total.playing + s.playing,
      audible: total.audible + s.audible,
      silent: total.silent + s.silent,
    }),
    { count: 0, playing: 0, audible: 0, silent: 0 }
  );
}

// Looks for a control that starts playback, in every frame. Attribute-based selectors come
// first because a play button is very often an icon with no text at all - the commonest shape
// on a webcast player, and invisible to any text match.
async function findPlayControl(page) {
  const selectors = [
    'button[aria-label*="play" i]',
    '[role=button][aria-label*="play" i]',
    'button[title*="play" i]',
    '[class*="play-button" i]',
    '[class*="playButton" i]',
    '[id*="play-button" i]',
    'button:visible',
    '[role=button]:visible',
    'a[role=button]:visible',
  ];

  for (const frame of page.frames()) {
    for (const selector of selectors) {
      const elements = await frame.$$(selector).catch(() => []);
      for (const el of elements) {
        const text = ((await el.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
        const label = (await el.getAttribute('aria-label').catch(() => '')) || '';
        const title = (await el.getAttribute('title').catch(() => '')) || '';
        const haystack = `${text} ${label} ${title}`;

        if (NEVER_CLICK_PATTERN.test(haystack)) continue;
        const isPlay =
          PLAY_TEXT_PATTERN.test(text) || /\bplay\b/i.test(label) || /\bplay\b/i.test(title);
        if (!isPlay) continue;

        const visible = await el.isVisible().catch(() => false);
        if (!visible) continue;
        return { el, label: (text || label || title).slice(0, 40) };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------- WebAudio and muted media
//
// A page can be "playing" and still emit no sound, and tab capture then records silence that
// looks exactly like a successful call. Two ways that happens, both seen in production:
//
//   TD.TO 2026Q3 on meetview.com: "The AudioContext was not allowed to start. It must be
//   resumed (or created) after a user gesture on the page." Chrome creates an AudioContext
//   suspended when there has been no user gesture, and it does NOT resume it by itself - the
//   page has to ask. That page starts its audio from a websocket message rather than from a
//   click, so it never asks, and no sound came out of the tab. mediaState() cannot see this at
//   all: there is no <audio> or <video> to inspect, so the old code reported "no media element
//   to start" and the capture recorded silence.
//
//   Muted autoplay: a player that starts muted - the only way Chrome allows autoplay - and
//   relies on the viewer to unmute it. Nobody does, so `paused` is false, `readyState` is good,
//   and the recording is silent.
//
// The AudioContext case cannot be fixed after the fact, because there is no API to enumerate
// contexts that already exist. The constructor has to be wrapped before any page script runs,
// which is what installAudioProbe() is for - it must be installed BEFORE navigation.
const AUDIO_PROBE_SCRIPT = () => {
  if (window.__fmpAudio) return;
  const contexts = [];
  window.__fmpAudio = {
    states: () => contexts.map((c) => c.state),
    resumeAll: () =>
      Promise.all(contexts.filter((c) => c.state === 'suspended').map((c) => c.resume().catch(() => {}))),
  };

  // A Proxy rather than a subclass: it leaves statics, the prototype chain and instanceof
  // intact, so a page that checks `ctx instanceof AudioContext` behaves exactly as before.
  const patch = (name) => {
    const Base = window[name];
    if (typeof Base !== 'function') return;
    window[name] = new Proxy(Base, {
      construct(target, args, newTarget) {
        const ctx = Reflect.construct(target, args, newTarget);
        contexts.push(ctx);
        // Retry on any gesture. The site's own resume() may already have been called and
        // refused, and there is no event for "activation has arrived", so this listens for the
        // gesture itself. Capture phase, so a handler that stops propagation cannot hide it.
        const retry = () => {
          if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        };
        for (const evt of ['pointerdown', 'mousedown', 'click', 'keydown', 'touchstart']) {
          document.addEventListener(evt, retry, { capture: true });
        }
        return ctx;
      },
    });
  };
  patch('AudioContext');
  patch('webkitAudioContext');
};

// Call immediately after context.newPage() and before goto: an init script added after
// navigation has already missed the constructors it needs to wrap.
async function installAudioProbe(page) {
  await page.addInitScript(AUDIO_PROBE_SCRIPT).catch(() => {});
}

// Per-frame AudioContext states. A frame with no probe reports nothing rather than zero,
// because "cannot tell" and "nothing suspended" lead to different decisions.
async function audioContextStates(page) {
  const out = [];
  for (const frame of page.frames()) {
    const states = await frame
      .evaluate(() => (window.__fmpAudio ? window.__fmpAudio.states() : null))
      .catch(() => null);
    if (states) out.push({ frame, states });
  }
  return out;
}

// A trusted user gesture, delivered without touching anything on the page.
//
// Needed because Chrome will not resume a suspended AudioContext, nor keep a muted-autoplay
// video playing once it is unmuted, without user activation - and activation does not propagate
// from a parent frame down into an iframe, so it has to be delivered to the frame that needs it.
//
// A transparent full-viewport overlay takes the click, so no site control is ever hit. That
// matters more than it sounds: nearly every regression in this project came from clicking a
// plausible-looking wrong thing, and clicking a bare coordinate is exactly that risk.
async function grantGesture(frame) {
  const handle = await frame
    .evaluateHandle(() => {
      const overlay = document.createElement('div');
      overlay.id = '__fmpGesture';
      overlay.setAttribute(
        'style',
        'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;background:transparent'
      );
      (document.body || document.documentElement).appendChild(overlay);
      return overlay;
    })
    .catch(() => null);
  if (!handle) return false;

  try {
    await handle.click({ timeout: 3000 });
    return true;
  } catch {
    return false;
  } finally {
    await frame
      .evaluate(() => {
        const el = document.getElementById('__fmpGesture');
        if (el) el.remove();
      })
      .catch(() => {});
    await handle.dispose().catch(() => {});
  }
}

// Unmutes media that is playing silently. Deliberately only touches media that is ALREADY
// playing: a paused element is the play-control path's business, and unmuting something that
// was never started risks turning on a promo clip instead of the call.
async function unmuteMedia(page) {
  let changed = 0;
  for (const frame of page.frames()) {
    const silent = await frame
      .evaluate(() => {
        let n = 0;
        for (const m of document.querySelectorAll('audio, video')) {
          if (m.paused || m.ended) continue;
          if (m.muted || m.volume === 0) n++;
        }
        return n;
      })
      .catch(() => 0);
    if (!silent) continue;

    // Activation does not reach into an iframe from its parent, so the gesture is delivered to
    // the frame that owns the muted element, not to the top of the page.
    await grantGesture(frame);

    const count = await frame
      .evaluate(() => {
        let n = 0;
        for (const m of document.querySelectorAll('audio, video')) {
          if (m.paused || m.ended) continue;
          if (!m.muted && m.volume > 0) continue;
          m.muted = false;
          if (m.volume === 0) m.volume = 1;
          n++;
          // Chrome pauses a muted-autoplay element the moment it is unmuted without user
          // activation. The gesture above is what stops that; this only covers the case where
          // it could not be delivered.
          if (m.paused) m.play().catch(() => {});
        }
        return n;
      })
      .catch(() => 0);
    changed += count;
  }
  return changed;
}

// Flattens the per-frame states into one tally.
function summarizeContexts(entries) {
  const all = entries.flatMap((entry) => entry.states);
  return {
    total: all.length,
    running: all.filter((state) => state === 'running').length,
    suspended: all.filter((state) => state === 'suspended').length,
  };
}

// Four escalating steps, each one addressing a way a joined call still records nothing:
//
//   1. press the site's play control, if playback has not begun
//   2. failing that, start the media element directly
//   3. unmute media that is playing silently
//   4. resume a WebAudio context Chrome blocked for want of a user gesture
//
// Returns both `playing` and `audible`, and they are not the same thing. `playing` was the only
// test the old version applied, and it is exactly the test a muted player and a suspended
// AudioContext both pass while producing silence. Callers should record `audible`.
//
// Never throws: this is a best-effort improvement, not a gate. Plenty of legitimate players are
// silent for a few minutes before a call starts, and refusing those would lose real calls to
// fix a problem they do not have.
async function ensurePlaying(page, logger) {
  const empty = { count: 0, playing: 0, audible: 0, silent: 0 };
  let state = await mediaState(page).catch(() => empty);
  const actions = [];

  // 1. Not playing at all - press the site's own control.
  if (state.playing === 0) {
    const control = await findPlayControl(page).catch(() => null);
    if (control) {
      const clicked = await control.el
        .click({ timeout: 4000 })
        .then(() => true)
        .catch((err) => {
          logger.warn(`Found a play control ("${control.label}") but could not click it: ${err.message}`);
          return false;
        });
      if (clicked) {
        logger.info(`Pressed "${control.label}" to start playback.`);
        actions.push(`clicked "${control.label}"`);
        await page.waitForTimeout(1500);
        state = await mediaState(page).catch(() => state);
      }
    }
  }

  // 2. Still nothing, but there is a media element - ask it directly. The click above counts as
  // a user gesture, so autoplay restrictions have usually been lifted by this point even when
  // the site's own button did nothing.
  if (state.playing === 0 && state.count > 0) {
    for (const frame of page.frames()) {
      await frame
        .evaluate(() => {
          for (const m of document.querySelectorAll('audio, video')) {
            if (m.paused) m.play().catch(() => {});
          }
        })
        .catch(() => {});
    }
    actions.push('started the media element directly');
    await page.waitForTimeout(1200);
    state = await mediaState(page).catch(() => state);
  }

  // 3. Playing, but every playing element is muted or at zero volume. The tab is recording
  // silence and nothing about it looks wrong from the outside.
  if (state.playing > 0 && state.audible === 0 && state.silent > 0) {
    const unmuted = await unmuteMedia(page).catch(() => 0);
    if (unmuted) {
      logger.info(`Unmuted ${unmuted} playing element(s) - the capture would have been silent.`);
      actions.push(`unmuted ${unmuted} element(s)`);
      await page.waitForTimeout(800);
      state = await mediaState(page).catch(() => state);
    }
  }

  // 4. No audible media element. If the page routes its audio through WebAudio there is nothing
  // for mediaState() to see, and a context created without a user gesture sits suspended until
  // the page asks it to resume - which a page that starts its audio from a websocket message
  // never does. This is what silently cost TD.TO 2026Q3.
  let webAudio = null;
  if (state.audible === 0) {
    const entries = await audioContextStates(page).catch(() => []);
    const blocked = entries.filter((entry) => entry.states.includes('suspended'));

    if (blocked.length) {
      const count = summarizeContexts(blocked).suspended;
      logger.info(`${count} WebAudio context(s) suspended - Chrome blocked them for want of a gesture. Supplying one.`);
      for (const entry of blocked) {
        await grantGesture(entry.frame);
        await entry.frame.evaluate(() => window.__fmpAudio && window.__fmpAudio.resumeAll()).catch(() => {});
      }
      await page.waitForTimeout(800);
    }

    webAudio = summarizeContexts(await audioContextStates(page).catch(() => []));
    if (blocked.length && webAudio.running > 0) {
      logger.info('WebAudio is running now.');
      actions.push('resumed a blocked WebAudio context');
    }
  }

  const audible = state.audible > 0 || Boolean(webAudio && webAudio.running > 0);

  let action;
  if (actions.length) action = actions.join('; ');
  else if (audible) action = 'already playing';
  else if (state.silent > 0) action = 'media is playing but muted';
  else if (state.count > 0) action = 'media present but still paused';
  else if (webAudio && webAudio.suspended > 0) action = `${webAudio.suspended} WebAudio context(s) still suspended`;
  else action = 'no media element to start';

  return { playing: state.playing > 0 || audible, audible, action, mediaCount: state.count, webAudio };
}

module.exports = { ensurePlaying, installAudioProbe, PLAY_TEXT_PATTERN, NEVER_CLICK_PATTERN };
