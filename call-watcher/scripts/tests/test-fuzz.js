// The wide sweep: hundreds of generated registration pages through the REAL pipeline.
//
// The gauntlet holds one hand-written fixture per provider that beat us, which locks in each
// specific bug and finds no new ones - every fixture is a combination somebody already thought
// of. This crosses the axes instead: label placement, id naming, required markers, dropdown
// shapes, consent shapes, waivers, decoys, multi-step gates. A hyphenated id with a left-hand
// label, a waiver checkbox and a "NEXT" button is a page nobody would write by hand, and it is
// exactly the sort of page that turns up on a Tuesday.
//
// Every generated page is one a competent person could complete in seconds. A failure here is
// a real gap, not an unfair test.
//
// Usage:
//   npm run test:fuzz              300 cases
//   npm run test:fuzz -- 1000      more
//   npm run test:fuzz -- --seed 417   reproduce one case exactly
const http = require('http');
const { chromium } = require('playwright-core');
const { advanceJoinFlow } = require('../../src/joinFlow');
const { fillRegistrationForm } = require('../../src/formFiller');
const { loadConfig } = require('../../src/loadConfig');
const { buildPage } = require('./generateRegistrationPage');

const config = loadConfig();
const identity = config.dummyIdentity;
const verbose = process.argv.includes('--verbose');
const onlySeed = process.argv.includes('--seed') ? Number(process.argv[process.argv.indexOf('--seed') + 1]) : null;
const total = Number(process.argv.find((a) => /^\d+$/.test(a)) || 300);

const logger = {
  info: (m) => verbose && console.log('      [INFO]', m),
  warn: (m) => verbose && console.log('      [WARN]', m),
};

// Pages are served rather than set via setContent so navigation, forms and the popup path all
// behave as they do on the web.
function startServer(pages) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const seed = Number(req.url.replace(/^\/|\?.*$/g, ''));
      const page = pages.get(seed);
      res.writeHead(page ? 200 : 404, { 'content-type': 'text/html' });
      res.end(page ? page.html : '<html><body>not found</body></html>');
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function inspect(page) {
  const out = { joined: false, forbidden: [], fields: [] };
  for (const frame of page.frames()) {
    const found = await frame
      .evaluate(() => {
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        return {
          joined: [...document.querySelectorAll('[data-incall]')].some(visible),
          forbidden: window.__forbiddenClicks || [],
          fields: [...document.querySelectorAll('[data-expect]')].map((el) => ({
            key: el.getAttribute('data-expect'),
            id: el.id,
            value: (el.value || '').trim(),
          })),
          error: (document.getElementById('error') || {}).textContent || '',
        };
      })
      .catch(() => null);
    if (!found) continue;
    out.joined = out.joined || found.joined;
    out.forbidden.push(...found.forbidden);
    out.fields.push(...found.fields);
    out.error = found.error;
  }
  return out;
}

(async () => {
  const seeds = onlySeed !== null ? [onlySeed] : Array.from({ length: total }, (_, i) => i + 1);
  const pages = new Map(seeds.map((seed) => [seed, buildPage(seed, identity)]));
  const { server, port } = await startServer(pages);

  const browser = await chromium.connectOverCDP(config.cdpUrl);
  const context = browser.contexts()[0];
  let page = await context.newPage();
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
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

  const failures = [];
  const started = Date.now();

  try {
    for (const [index, seed] of seeds.entries()) {
      const generated = pages.get(seed);
      await page.goto(`http://127.0.0.1:${port}/${seed}`, { waitUntil: 'domcontentloaded' });

      const problems = [];
      try {
        page = await advanceJoinFlow(page, logger);
        const registration = await fillRegistrationForm(page, identity, logger, undefined, { attempt: 1 });
        if (registration.page) page = registration.page;
        page = await advanceJoinFlow(page, logger);
      } catch (err) {
        problems.push(`threw: ${err.message.split('\n')[0].slice(0, 80)}`);
      }

      const result = await inspect(page);

      // 1. Nothing forbidden may be touched. One wrong click is a failure on its own, even if
      //    the page somehow still ends up joined.
      if (result.forbidden.length) problems.push(`clicked forbidden: ${[...new Set(result.forbidden)].join(', ')}`);

      // 2. Every field must hold what it was meant to hold.
      for (const field of result.fields) {
        if (field.key === 'none') {
          if (field.value) problems.push(`${field.id}: expected empty, got ${JSON.stringify(field.value)}`);
          continue;
        }
        const want = String(identity[field.key] ?? '');
        if (!field.value) problems.push(`${field.id}: expected ${field.key}, got empty`);
        else if (want && field.value.toLowerCase() !== want.toLowerCase()) {
          problems.push(`${field.id}: expected ${JSON.stringify(want)}, got ${JSON.stringify(field.value)}`);
        }
      }

      // 3. And the point of the whole exercise: we must be through the gate.
      if (!result.joined) {
        problems.push(`not joined${result.error ? ` (page says: ${String(result.error).slice(0, 60)})` : ''}`);
      }

      if (problems.length) failures.push({ seed, shape: generated.shape, problems });

      if ((index + 1) % 25 === 0 || index === seeds.length - 1) {
        const rate = (index + 1 - failures.length) / (index + 1);
        process.stdout.write(
          `\r  ${index + 1}/${seeds.length} cases  ${failures.length} failing  ${(rate * 100).toFixed(1)}% pass  ` +
            `${((Date.now() - started) / 1000).toFixed(0)}s   `
        );
      }
    }
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
    server.close();
  }

  console.log('\n' + '-'.repeat(86));

  // Grouped by the shape that broke, not by case number: twenty failures from one label style
  // is one bug, and listing twenty cases hides that.
  if (failures.length) {
    const byShape = new Map();
    for (const failure of failures) {
      for (const problem of failure.problems) {
        // The specific id changes case to case; the kind of problem does not.
        const kind = problem.replace(/^[^:]+: /, '').replace(/"[^"]*"/g, '"..."').slice(0, 60);
        const key = `${failure.shape.labelStyle} / ${failure.shape.idStyle} / ${kind}`;
        if (!byShape.has(key)) byShape.set(key, []);
        byShape.get(key).push(failure.seed);
      }
    }
    console.log('FAILURES, grouped by shape');
    console.log('-'.repeat(86));
    for (const [shape, cases] of [...byShape.entries()].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  ${String(cases.length).padStart(4)}  ${shape}`);
      console.log(`        reproduce: npm run test:fuzz -- --seed ${cases[0]} --verbose`);
    }
    console.log('-'.repeat(86));
  }

  console.log(`${seeds.length - failures.length} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})().catch((err) => {
  console.error('fuzz sweep crashed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
