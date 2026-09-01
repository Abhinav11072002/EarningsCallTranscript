// Exercises webcast-link resolution against a local dummy site covering the real shapes the
// portal's "dial-in link" turns out to be. This is the question that matters most in practice:
// the link is frequently NOT the player, and landing on the wrong page produces a capture that
// looks successful while containing the wrong audio.
//
// Two hostnames both resolve to the loopback interface, which lets the fixture distinguish
// "third-party webcast provider" from "the company's own IR site" without touching the network:
//   127.0.0.1  -> configured as a known provider domain
//   localhost   -> the company's IR site (not a known provider)
//
// Each case declares what SHOULD happen and why. Two of these (a PDF slide deck as the only
// provider-domain link, and an events index listing the archived quarter first) originally
// resolved to the WRONG page; they are kept as regression tests for exactly that.
const http = require('http');
const { chromium } = require('playwright-core');
const { resolveWebcastPage } = require('../../src/webcastResolver');
const { loadConfig } = require('../../src/loadConfig');

const config = loadConfig();
const silent = { info: () => {}, warn: () => {} };

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = req.url;
      const provider = (path) => `http://127.0.0.1:${server.address().port}${path}`;
      const send = (html, status = 200) => {
        res.writeHead(status, { 'content-type': 'text/html' });
        res.end(html);
      };

      // ---- pages served on the "provider" host (127.0.0.1) ----
      if (url === '/player') return send('<title>Q2 2026 Earnings Call</title><h1>Live player</h1>');
      if (url === '/player-archived') return send('<title>Q1 2026 Earnings Call (archived)</title><h1>Archive</h1>');
      if (url === '/deck.pdf') {
        res.writeHead(200, { 'content-type': 'application/pdf' });
        return res.end('%PDF-1.4 fake');
      }

      // ---- pages served on the "IR site" host (localhost) ----
      if (url === '/direct-provider') return send('<title>Direct player</title><h1>player</h1>');

      if (url === '/cta-text') {
        return send(`<h1>Investor Relations</h1><a href="${provider('/player')}">Listen to Webcast</a>`);
      }
      if (url === '/domain-link-odd-wording') {
        // Wording the text matcher would never catch; only the domain check saves this.
        return send(`<h1>Results</h1><a href="${provider('/player')}">Q2 FY26 event access</a>`);
      }
      if (url === '/iframe-embedded') {
        return send(`<h1>Results</h1><iframe src="${provider('/player')}" width="300" height="200"></iframe>`);
      }
      if (url === '/needs-nav-hop') {
        return send('<h1>Company</h1><a href="/events-index">Events &amp; Presentations</a>');
      }
      if (url === '/events-index') {
        return send(`<h1>Events</h1><a href="${provider('/player')}">Listen to Webcast</a>`);
      }
      if (url === '/AED_Slides_H1-2026_Webcast_2026-09-01_LV.pdf' || url === '/CorpcamPrivacy.pdf') {
        res.writeHead(200, { 'content-type': 'application/pdf' });
        return res.end('%PDF-1.4 fake');
      }
      if (url === '/cta-to-own-pdf') {
        // AED.BR and AEDFF, 2026-09-01. A slide deck whose FILENAME contains "Webcast", labelled
        // with wording the CTA matcher accepts, on the company's own host so the provider-domain
        // scan never sees it. Both calls resolved to the PDF and were lost.
        return send('<h1>H1 2026 Results</h1><a href="/AED_Slides_H1-2026_Webcast_2026-09-01_LV.pdf">Audio webcast</a>');
      }
      if (url === '/cta-to-privacy') {
        // The corpcam shape: the only wording match on the page points at site furniture.
        return send('<h1>Webcast</h1><a href="/privacy-policy">Listen to the webcast</a>');
      }
      if (url.startsWith('/?event=')) {
        // Proof the furniture rule does not over-reach: plenty of providers serve the call from
        // the ROOT with the event in the query string, and those must still be followed.
        return send('<title>Q2 2026 Earnings Call</title><h1>Live player</h1>');
      }
      if (url === '/cta-to-root-query') {
        return send(`<h1>Results</h1><a href="http://localhost:${server.address().port}/?event=123">Listen to Webcast</a>`);
      }
      if (url === '/pdf-only') {
        // The only provider-domain link is a slide deck. Recording this is silently wrong.
        return send(`<h1>Results</h1><a href="${provider('/deck.pdf')}">Q2 2026 Earnings Presentation</a>`);
      }
      if (url === '/multi-quarter') {
        // Archived quarter listed FIRST, current call second - DOM order picks the wrong one.
        return send(
          `<h1>Events</h1>
           <a href="${provider('/player-archived')}">Q1 2026 Earnings Call</a>
           <a href="${provider('/player')}">Q2 2026 Earnings Call</a>`
        );
      }
      if (url === '/footer-branding') {
        // Long footer line containing "webcast" - must not be mistaken for a CTA.
        return send(
          '<h1>Results</h1><footer>Webcasting Platform Powered by ACCESS Newswire Inc. ' +
            '&copy; Copyright 2026 All Rights Reserved.</footer>'
        );
      }
      if (url === '/malformed-href') {
        // A single bad href must not abort the whole domain scan.
        return send(`<a href="http://[not a url">broken</a><a href="${provider('/player')}">Listen to Webcast</a>`);
      }
      if (url === '/redirects') {
        res.writeHead(302, { location: provider('/player') });
        return res.end();
      }
      if (url === '/login-wall') {
        return send('<h1>Sign in required</h1><form><label>Password <input type="password" name="pw"></label><button type="submit">Log in</button></form>');
      }
      if (url === '/dead') return send('<title>Page Not Found</title><h1>404</h1>', 404);
      if (url === '/no-signal') return send('<h1>Corporate news</h1><p>Nothing relevant here.</p>');

      return send('<h1>Unknown</h1>', 404);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

(async () => {
  const server = await startServer();
  const port = server.address().port;
  const ir = (p) => `http://localhost:${port}${p}`;
  const prov = (p) => `http://127.0.0.1:${port}${p}`;

  // 127.0.0.1 is the "known provider"; localhost is the company's own site.
  const cfg = { knownDirectProviderDomains: ['127.0.0.1'] };

  const cases = [
    {
      name: 'already the player (known provider domain)',
      start: prov('/player'),
      expect: (u) => u === prov('/player'),
      why: 'must stay put',
    },
    {
      name: 'IR landing page with a "Listen to Webcast" CTA',
      start: ir('/cta-text'),
      expect: (u) => u === prov('/player'),
      why: 'follows the text CTA to the player',
    },
    {
      name: 'IR page linking to a provider domain with unrecognisable wording',
      start: ir('/domain-link-odd-wording'),
      expect: (u) => u === prov('/player'),
      why: 'domain check catches what text matching cannot',
    },
    {
      name: 'player embedded in an iframe',
      start: ir('/iframe-embedded'),
      expect: (u) => u === ir('/iframe-embedded'),
      why: 'stays on the parent page - tab capture records the iframe too',
    },
    {
      name: 'requires one navigational hop (Events & Presentations)',
      start: ir('/needs-nav-hop'),
      expect: (u) => u === prov('/player'),
      why: 'hops to the events index, then resolves the player',
    },
    {
      name: 'CTA wording pointing at a PDF on the same host as the landing page',
      start: ir('/cta-to-own-pdf'),
      expect: (u) => u === ir('/cta-to-own-pdf'),
      why: 'must not follow wording to a file - AED.BR and AEDFF were lost to exactly this',
    },
    {
      name: 'CTA wording pointing at site furniture',
      start: ir('/cta-to-privacy'),
      expect: (u) => u === ir('/cta-to-privacy'),
      why: 'a privacy page is not a call, however the link is labelled',
    },
    {
      name: 'CTA wording pointing at a root path with a query string',
      start: ir('/cta-to-root-query'),
      expect: (u) => u.includes('/?event=123'),
      why: 'the furniture rule must not refuse a call served from the root',
    },
    {
      name: 'long footer branding containing the word "webcast"',
      start: ir('/footer-branding'),
      expect: (u) => u === ir('/footer-branding'),
      why: 'must NOT be treated as a CTA (the 60-char cap)',
    },
    {
      name: 'one malformed href alongside a good CTA',
      start: ir('/malformed-href'),
      expect: (u) => u === prov('/player'),
      why: 'a bad anchor must not abort the scan',
    },
    {
      name: 'dial-in link redirects to the provider',
      start: ir('/redirects'),
      expect: (u) => u === prov('/player'),
      why: 'redirect lands on a known provider, so it resolves directly',
    },
    {
      name: 'no recognisable signal at all',
      start: ir('/no-signal'),
      expect: (u) => u === ir('/no-signal'),
      why: 'proceeds as-is and warns (a human then sees the warning)',
    },
    {
      name: 'dead link (404 page)',
      start: ir('/dead'),
      expect: (u) => u === ir('/dead'),
      why: 'stays put; the trigger refuses to record a "Page Not Found" title',
    },
    {
      name: 'login wall',
      start: ir('/login-wall'),
      expect: (u) => u === ir('/login-wall'),
      why: 'no webcast link exists; must not wander off',
    },
    // ---- regressions: these both used to resolve to the WRONG page ----
    {
      name: 'only provider-domain link is a PDF slide deck',
      start: ir('/pdf-only'),
      expect: (u) => u === ir('/pdf-only'),
      why: 'a PDF is not a webcast - recording it is silently wrong',
    },
    {
      name: 'events index listing archived quarter before the current one',
      start: ir('/multi-quarter'),
      expect: (u) => u === prov('/player'),
      why: 'should prefer the current call, not the first link in DOM order',
    },
  ];

  const browser = await chromium.connectOverCDP(config.cdpUrl, { timeout: 60000 });
  const context = browser.contexts()[0];
  const failures = [];
  const gaps = [];

  try {
    for (const c of cases) {
      let landed = '(threw)';
      let page = null;
      try {
        page = await resolveWebcastPage(context, c.start, cfg, silent, c.hints ?? { symbol: 'ACME', year: '2026', period: 'Q2' });
        landed = page.url();
      } catch (err) {
        landed = `(threw: ${err.message})`;
      } finally {
        if (page) await page.close().catch(() => {});
      }
      const ok = c.expect(landed);
      const tag = ok ? 'PASS' : c.knownGap ? 'GAP ' : 'FAIL';
      console.log(`${tag} ${c.name}`);
      if (!ok) {
        console.log(`       expected: ${c.why}`);
        console.log(`       landed on: ${landed}`);
        (c.knownGap ? gaps : failures).push(c.name);
      }
    }
  } finally {
    server.close();
    await browser.close().catch(() => {});
  }

  console.log('');
  console.log(`${cases.length - failures.length - gaps.length}/${cases.length} as specified`);
  if (gaps.length) console.log(`known gaps (documented, not yet fixed): ${gaps.length} -> ${gaps.join('; ')}`);
  if (failures.length) {
    console.error(`REGRESSIONS: ${failures.join('; ')}`);
    process.exit(1);
  }
  process.exit(0);
})().catch((error) => {
  console.error('Webcast resolver test failed to run:', error.message);
  process.exit(1);
});
