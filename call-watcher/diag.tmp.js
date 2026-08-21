const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { loadConfig } = require('./src/loadConfig');
const { matchField } = require('./src/formFiller');

const fixture = process.argv[2];
const config = loadConfig();

(async () => {
  const browser = await chromium.connectOverCDP(config.cdpUrl, { timeout: 60000 });
  const page = await browser.contexts()[0].newPage();
  await page.setContent(fs.readFileSync(path.join('test/fixtures/registration', fixture), 'utf8'));

  const dump = await page.evaluate(() => {
    const FURNITURE = 'nav, header, footer, [role=navigation], [role=search], [role=banner], [role=contentinfo]';
    const out = [];
    for (const node of document.querySelectorAll('input, select, textarea')) {
      const r = node.getBoundingClientRect();
      // same geometric nearest-label search as describeField
      let best = null, bestGap = Infinity;
      for (const c of document.querySelectorAll('label, p, span, div, legend')) {
        if (c.contains(node) || node.contains(c)) continue;
        const t = (c.textContent || '').trim();
        if (!t || t.length > 60) continue;
        const cr = c.getBoundingClientRect();
        if (cr.width === 0 || cr.height === 0) continue;
        const vGap = r.top - cr.bottom;
        const hOverlap = Math.min(r.right, cr.right) - Math.max(r.left, cr.left);
        if (vGap >= -5 && vGap <= 60 && hOverlap > -50 && vGap < bestGap) { bestGap = vGap; best = t; }
      }
      let assocLabel = null;
      if (node.id) { const l = document.querySelector(`label[for="${node.id}"]`); if (l) assocLabel = l.textContent; }
      if (!assocLabel) { const p = node.closest('label'); if (p) assocLabel = p.textContent; }
      out.push({
        expect: node.getAttribute('data-expect'),
        name: node.name || node.id || '(none)',
        type: node.type,
        rect: { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) },
        offscreen: r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight,
        disabled: node.disabled, readOnly: node.readOnly,
        furniture: Boolean(node.closest(FURNITURE)),
        assocLabel: assocLabel ? assocLabel.trim() : null,
        nearest: best, nearestGap: bestGap === Infinity ? null : Math.round(bestGap),
        parts: [node.name, node.id, node.placeholder, node.getAttribute('aria-label'), node.getAttribute('autocomplete')].filter(Boolean),
      });
    }
    const buttons = [...document.querySelectorAll('button:not([hidden]), input[type=submit], a[role=button]')]
      .filter((b) => b.getBoundingClientRect().height > 0)
      .map((b) => ({ text: (b.innerText || b.value || '').trim(), type: b.type || '', furniture: Boolean(b.closest(FURNITURE)) }));
    return { out, buttons };
  });

  console.log(`=== ${fixture} ===`);
  for (const f of dump.out) {
    const desc = [...f.parts, f.assocLabel, f.nearest].filter(Boolean).join(' ');
    console.log(`  field ${f.name} (expect=${f.expect}) type=${f.type} off=${f.offscreen} dis=${f.disabled} ro=${f.readOnly}`);
    console.log(`     rect=${JSON.stringify(f.rect)} assoc=${JSON.stringify(f.assocLabel)} nearest=${JSON.stringify(f.nearest)} gap=${f.nearestGap}`);
    console.log(`     description -> ${JSON.stringify(desc)}  => matchField=${matchField(desc)}`);
  }
  console.log('  buttons:', JSON.stringify(dump.buttons));
  await page.close();
  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('diag failed:', e.message); process.exit(1); });
