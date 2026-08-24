// The wide adversarial sweep: every fixture is run through the REAL pipeline steps in the real
// order - advanceJoinFlow -> fillRegistrationForm -> advanceJoinFlow -> describeJoinBlocker -
// so this tests what actually happens to a call, not the individual helpers in isolation.
//
// Fixtures are self-describing (see test/fixtures/gauntlet/*.html):
//   <meta name="expect-joined">  the run should end inside the call
//   <meta name="expect-refused"> the relevance guard should refuse to record the page
//   <meta name="expect-pending"> the form filler should report the gate as still blocking
//   data-forbidden="true"        clicking this element is a FAILURE, not a near miss
//   data-expect="email"          field must hold that identity value ("none" = stay empty)
//
// data-forbidden is the important one. Most of the damage in this project has come from
// clicking a plausible-looking wrong thing - a native-app handler that steals the foreground,
// a replay link, a "Leave" button - and every one of those produces a page that still looks
// broadly reasonable afterwards.
//
// Usage: npm run test:gauntlet   (needs the debug Chrome running)
const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright-core');
const { advanceJoinFlow, describeJoinBlocker } = require('../src/joinFlow');
const { fillRegistrationForm } = require('../src/formFiller');
const { loadConfig } = require('../src/loadConfig');

const config = loadConfig();
const identity = config.dummyIdentity;
const fixtureDir = path.join(__dirname, '..', 'test', 'fixtures', 'gauntlet');

const verbose = process.argv.includes('--verbose');
const logger = {
  info: (m) => verbose && console.log('      [INFO]', m),
  warn: (m) => verbose && console.log('      [WARN]', m),
};

// Served rather than setContent so navigation between fixtures behaves like the real web:
// /gauntlet/<name> maps to <name>.html, which is what the fixtures link to each other by.
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const name = req.url.split('?')[0].replace(/^\/gauntlet\//, '').replace(/\/$/, '');
      const file = path.join(fixtureDir, `${name}.html`);
      if (!name || !fs.existsSync(file)) {
        res.writeHead(404, { 'content-type': 'text/html' });
        res.end('<html><body><h1>Page not found</h1></body></html>');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(fs.readFileSync(file, 'utf8'));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// Fixtures reached only as a second page (they are exercised via the page that links to them).
const ENTRY_EXCLUDED = new Set(['iframe-inner.html', 'teams-prejoin.html']);

async function readExpectations(page) {
  return page.evaluate(() => {
    const meta = (n) => {
      const el = document.querySelector(`meta[name="${n}"]`);
      return el ? el.getAttribute('content') === 'true' : false;
    };
    return {
      joined: meta('expect-joined'),
      refused: meta('expect-refused'),
      pending: meta('expect-pending'),
    };
  });
}

// True if any frame shows an element marked as "we are inside the call".
async function isInCall(page) {
  for (const frame of page.frames()) {
    const visible = await frame
      .evaluate(() => {
        for (const el of document.querySelectorAll('[data-incall]')) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return true;
        }
        return false;
      })
      .catch(() => false);
    if (visible) return true;
  }
  return false;
}

async function forbiddenClicks(page) {
  const hits = [];
  for (const frame of page.frames()) {
    const found = await frame.evaluate(() => window.__forbiddenClicks || []).catch(() => []);
    hits.push(...found);
  }
  return hits;
}

async function fieldProblems(page, dummy) {
  const problems = [];
  for (const frame of page.frames()) {
    const found = await frame
      .evaluate((values) => {
        const out = [];
        for (const el of document.querySelectorAll('[data-expect]')) {
          const key = el.getAttribute('data-expect');
          const value = (el.value || '').trim();
          if (key === 'none') {
            if (value) out.push(`${el.id || el.name}: expected empty, got ${JSON.stringify(value)}`);
            continue;
          }
          const want = key === 'fullName' ? values.fullName : values[key];
          if (!value) out.push(`${el.id || el.name}: expected ${key}, got empty`);
          else if (want && value.toLowerCase() !== String(want).toLowerCase()) {
            out.push(`${el.id || el.name}: expected ${JSON.stringify(want)}, got ${JSON.stringify(value)}`);
          }
        }
        return out;
      }, { ...dummy, fullName: `${dummy.firstName} ${dummy.lastName}` })
      .catch(() => []);
    problems.push(...found);
  }
  return problems;
}

const rows = [];

(async () => {
  const { server, port } = await startServer();
  const base = `http://127.0.0.1:${port}/gauntlet`;
  const browser = await chromium.connectOverCDP(config.cdpUrl);
  const context = browser.contexts()[0];
  let page = await context.newPage();
  page.on('dialog', (d) => d.dismiss().catch(() => {}));

  // Records forbidden clicks in every document, including ones created by later navigations
  // and inside iframes - a click that navigates away would otherwise erase its own evidence.
  await page.addInitScript(() => {
    window.__forbiddenClicks = [];
    document.addEventListener(
      'click',
      (e) => {
        const el = e.target && e.target.closest ? e.target.closest('[data-forbidden]') : null;
        if (el) window.__forbiddenClicks.push((el.innerText || el.value || 'unnamed').trim());
      },
      true
    );
  });

  const fixtures = fs
    .readdirSync(fixtureDir)
    .filter((f) => f.endsWith('.html') && !ENTRY_EXCLUDED.has(f))
    .sort();

  try {
    for (const fixture of fixtures) {
      const name = fixture.replace(/\.html$/, '');
      await page.goto(`${base}/${name}`, { waitUntil: 'domcontentloaded' });
      const expected = await readExpectations(page);

      const started = Date.now();
      let crash = null;
      let pending = false;
      try {
        // Exactly the sequence src/index.js runs for a real call.
        // Reassigned exactly as src/index.js does: an entry link may open the call in a new
        // tab, and everything after this point must act on that tab.
        page = await advanceJoinFlow(page, logger);
        const reg = await fillRegistrationForm(page, identity, logger);
        // The filler can adopt a popup and CLOSE the page it was given, so this reassignment is
        // not cosmetic - without it the next step runs against a closed tab and throws.
        if (reg.page) page = reg.page;
        pending = Boolean(reg.pending);
        page = await advanceJoinFlow(page, logger);
      } catch (err) {
        crash = err.message;
      }
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);

      const blocker = await describeJoinBlocker(page).catch(() => null);
      const joined = await isInCall(page);
      const forbidden = await forbiddenClicks(page);
      const badFields = await fieldProblems(page, identity);

      const problems = [];
      if (crash) problems.push(`threw: ${crash}`);
      if (forbidden.length) problems.push(`clicked forbidden: ${forbidden.join(', ')}`);
      if (badFields.length) problems.push(...badFields);
      if (expected.joined !== joined) problems.push(`joined=${joined}, expected ${expected.joined}`);
      if (expected.refused !== Boolean(blocker)) {
        problems.push(`refused=${Boolean(blocker)}, expected ${expected.refused}${blocker ? ` (${blocker})` : ''}`);
      }
      if (expected.pending !== pending) problems.push(`pending=${pending}, expected ${expected.pending}`);
      // Everything here runs under the pipeline lock in production, so a slow fixture is a
      // real finding: it delays every later call in the same 15-minute window.
      if (Number(elapsed) > 20) problems.push(`took ${elapsed}s under the pipeline lock`);

      rows.push({ name, elapsed, joined, blocker: Boolean(blocker), pending, problems });
      console.log(`${problems.length ? 'FAIL' : 'PASS'} ${name.padEnd(28)} ${elapsed}s`);
      for (const p of problems) console.log(`       ${p}`);
    }
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
    server.close();
  }

  const failed = rows.filter((r) => r.problems.length);
  console.log('\n' + '-'.repeat(78));
  console.log('fixture'.padEnd(30) + 'time'.padEnd(8) + 'joined'.padEnd(9) + 'refused'.padEnd(10) + 'pending');
  console.log('-'.repeat(78));
  for (const r of rows) {
    console.log(
      r.name.padEnd(30) +
        `${r.elapsed}s`.padEnd(8) +
        String(r.joined).padEnd(9) +
        String(r.blocker).padEnd(10) +
        String(r.pending)
    );
  }
  console.log('-'.repeat(78));
  console.log(`${rows.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error('gauntlet crashed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
