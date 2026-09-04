// End-to-end coverage for the pre-join interstitials that cost NSCIF 2026Q2 its recording.
//
// Unlike the registration fixtures, these need real navigation between pages (lobby -> web
// client), so they are served over HTTP rather than injected with setContent.
//
// Usage: npm run test:join   (needs the debug Chrome running, same as the other browser tests)
const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright-core');
const { advanceJoinFlow, describeJoinBlocker, findBrowserEntryAction } = require('../../src/joinFlow');
const { fillRegistrationForm } = require('../../src/formFiller');
const { loadConfig } = require('../../src/loadConfig');

const config = loadConfig();
const identity = config.dummyIdentity;
const fixtureDir = path.join(__dirname, '..', '..', 'test', 'fixtures', 'join');

const quiet = process.argv.includes('--quiet');
const logger = {
  info: (m) => !quiet && console.log('    [INFO]', m),
  warn: (m) => !quiet && console.log('    [WARN]', m),
};

// Routes chosen to mirror the real URL shapes, so the lobby's "Join from browser" href is a
// genuine cross-page navigation exactly as it is on zoom.us.
const ROUTES = {
  '/j/83171321596': 'zoom-lobby.html',
  '/wc/83171321596/join': 'zoom-webclient.html',
  '/app-only': 'app-only-lobby.html',
  '/native-plus-form': 'native-app-plus-form.html',
  '/in-meeting': 'in-meeting.html',
  '/webinar/register/WN_x': 'zoom-webinar-register.html',
  '/zoom-join-choice': 'zoom-join-choice.html',
  '/zoom-media-prompt': 'zoom-media-prompt.html',
  '/zoom-enter-name': 'zoom-enter-name.html',
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const route = req.url.split('?')[0];
      const file = ROUTES[route];
      if (!file) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(fs.readFileSync(path.join(fixtureDir, file), 'utf8'));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
}

const nativeWasClicked = (page) => page.evaluate(() => Boolean(window.__nativeClicked)).catch(() => false);

(async () => {
  const { server, port } = await startServer();
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.connectOverCDP(config.cdpUrl);
  const context = browser.contexts()[0];
  let page = await context.newPage();
  page.on('dialog', (d) => d.dismiss().catch(() => {}));

  try {
    // 1. The exact failure, end to end: lobby -> browser client -> name -> in the meeting.
    await page.goto(`${base}/j/83171321596`);
    const blockerAtLobby = await describeJoinBlocker(page);
    record('lobby is recognised as not-yet-in-the-call', Boolean(blockerAtLobby), blockerAtLobby || 'no blocker reported');

    page = await advanceJoinFlow(page, logger);
    const reachedClient = page.url().includes('/wc/83171321596/join');
    record('lobby advances to the browser client', reachedClient, page.url());

    const reg = await fillRegistrationForm(page, identity, logger);
    if (reg.page) page = reg.page;
    page = await advanceJoinFlow(page, logger);
    const nameValue = await page.locator('#input-for-name').inputValue().catch(() => '');
    const inMeeting = await page.locator('#inmeeting').isVisible().catch(() => false);
    record('name is filled and Join submitted', inMeeting && Boolean(nameValue.trim()), `name=${JSON.stringify(nameValue)} pending=${reg.pending}`);

    const blockerInMeeting = await describeJoinBlocker(page);
    record('once in the meeting nothing blocks the capture', blockerInMeeting === null, blockerInMeeting || 'clear');
    record('the native-app button was never clicked', !(await nativeWasClicked(page)));

    // 1b. A real Zoom webinar, all four screens, walked through by the operator who does it by
    //     hand: registration form -> "Join from browser" -> a modal asking for microphone and
    //     camera -> a second form wanting a display name. Interstitials and forms alternate, so
    //     one pass of each cannot get past the third screen. GWRE, GROW, PANW and RGS all
    //     stopped there and were reported as having no player.
    //
    //     The two forbidden clicks are asserted separately because either one is worse than
    //     failing: the app button steals the OS foreground, and granting the microphone puts the
    //     room's own sound into a call we are only listening to.
    await page.goto(`${base}/webinar/register/WN_x`);
    let zoomReg = { pending: false };
    for (let round = 0; round < 3; round++) {
      const startedAt = page.url();
      page = await advanceJoinFlow(page, logger);
      zoomReg = await fillRegistrationForm(page, identity, logger, (adopted) => { page = adopted; });
      if (zoomReg.page) page = zoomReg.page;
      page = await advanceJoinFlow(page, logger);
      if (page.url() === startedAt) break;
    }
    const zoomInMeeting = page.url().includes('/in-meeting');
    record('zoom webinar: all four screens are crossed', zoomInMeeting, page.url());
    record('zoom webinar: the Workplace app was never clicked', !(await nativeWasClicked(page)));
    record(
      'zoom webinar: microphone and camera were never granted',
      !(await page.evaluate(() => Boolean(window.__usedMic)).catch(() => false))
    );

    // 1c. The media prompt on its own, crossed by advanceJoinFlow alone. It is a modal with TWO
    //     controls, so the single-control overlay rule cannot see it, and neither phrasing is a
    //     browser-entry wording - without a rule of its own the interstitial walker stops dead
    //     here even though the form filler would have got past it later.
    await page.goto(`${base}/zoom-media-prompt`);
    page = await advanceJoinFlow(page, logger);
    record('media prompt is crossed by the join walker alone', page.url().includes('/zoom-enter-name'), page.url());
    record('media prompt: microphone was not granted', !(await page.evaluate(() => Boolean(window.__usedMic)).catch(() => false)));

    // 2. No browser option at all. Clicking the app button is worse than failing, so the
    //    correct outcome is: touch nothing, and let the guard refuse.
    await page.goto(`${base}/app-only`);
    const action = await findBrowserEntryAction(page);
    record('app-only lobby offers no browser entry', action === null, action ? `found ${action.kind}: ${action.text}` : 'none');
    page = await advanceJoinFlow(page, logger);
    record('app-only lobby: nothing was clicked', !(await nativeWasClicked(page)));
    const appOnlyBlocker = await describeJoinBlocker(page);
    record('app-only lobby is refused by the guard', Boolean(appOnlyBlocker), appOnlyBlocker || 'NOT refused');

    // 3. A genuine form beside a native-app CTA: fill the form, leave the button alone.
    await page.goto(`${base}/native-plus-form`);
    page = await advanceJoinFlow(page, logger);
    const formResult = await fillRegistrationForm(page, identity, logger);
    if (formResult.page) page = formResult.page;
    const submitted = await page.locator('#result').isVisible().catch(() => false);
    record('form beside an app button still registers', submitted && !formResult.pending, `pending=${formResult.pending}`);
    record('form beside an app button: app left alone', !(await nativeWasClicked(page)));

    // 4. Already joined: the flow must not interfere and the guard must not refuse.
    await page.goto(`${base}/in-meeting`);
    const before = page;
    page = await advanceJoinFlow(page, logger);
    const stillThere = page === before && page.url().endsWith('/in-meeting');
    record('in-meeting page is left untouched', stillThere, `sameTab=${page === before} url=${page.url()}`);
    const liveBlocker = await describeJoinBlocker(page);
    record('in-meeting page is not refused', liveBlocker === null, liveBlocker || 'clear');
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
    server.close();
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error('join-flow test crashed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
