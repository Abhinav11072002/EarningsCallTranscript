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
        return {
          count: media.length,
          playing: media.filter((m) => !m.paused && !m.ended && m.readyState > 0).length,
        };
      })
      .catch(() => null);
    if (state) states.push(state);
  }
  return states.reduce(
    (total, s) => ({ count: total.count + s.count, playing: total.playing + s.playing }),
    { count: 0, playing: 0 }
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

// Returns what happened, so the caller can record whether the page was audibly live rather than
// merely joined. Never throws: this is a best-effort improvement, not a gate.
async function ensurePlaying(page, logger) {
  const before = await mediaState(page).catch(() => ({ count: 0, playing: 0 }));

  if (before.playing > 0) return { playing: true, action: 'already playing', mediaCount: before.count };

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
      await page.waitForTimeout(1500);
      const after = await mediaState(page).catch(() => ({ count: 0, playing: 0 }));
      if (after.playing > 0) return { playing: true, action: `clicked "${control.label}"`, mediaCount: after.count };
    }
  }

  // No control found, or clicking it did not start anything. Ask the media element directly -
  // Playwright's click above counts as a user gesture, so autoplay restrictions have usually
  // been lifted by this point even when the site's own button did nothing.
  if (before.count > 0) {
    for (const frame of page.frames()) {
      await frame
        .evaluate(() => {
          for (const m of document.querySelectorAll('audio, video')) {
            if (m.paused) m.play().catch(() => {});
          }
        })
        .catch(() => {});
    }
    await page.waitForTimeout(1200);
    const after = await mediaState(page).catch(() => ({ count: 0, playing: 0 }));
    if (after.playing > 0) return { playing: true, action: 'started the media element directly', mediaCount: after.count };
  }

  // Not a failure. A live call whose audio has not begun yet looks exactly like this, and so
  // does a player built on WebAudio with no media element to inspect.
  return {
    playing: false,
    action: before.count ? 'media present but still paused' : 'no media element to start',
    mediaCount: before.count,
  };
}

module.exports = { ensurePlaying, PLAY_TEXT_PATTERN, NEVER_CLICK_PATTERN };
