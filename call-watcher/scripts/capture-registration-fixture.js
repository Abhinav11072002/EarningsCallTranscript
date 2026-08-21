// Capture a sanitized registration page from the already-running debug Chrome.
// Usage: node scripts/capture-registration-fixture.js <provider> [url-fragment]
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { loadConfig } = require('../src/loadConfig');

const config = loadConfig();

const provider = process.argv[2];
const urlFragment = process.argv[3] || '';
if (!provider) {
  console.error('Usage: node scripts/capture-registration-fixture.js <provider> [url-fragment]');
  process.exit(1);
}

function redactDom(html) {
  return html
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, 'redacted@example.test')
    .replace(/\b(?:\+?\d[\d\s().-]{7,}\d)\b/g, '0000000000')
    .replace(/(\b(?:value|data-value|data-email|data-phone|data-token|data-key)\s*=\s*["'])[^"']*(["'])/gi, '$1REDACTED$2')
    .replace(/(\b(?:name|id)\s*=\s*["'](?:csrf|token|api[-_]?key|password)[^"']*["'][^>]*\bvalue\s*=\s*["'])[^"']*(["'])/gi, '$1REDACTED$2');
}

(async () => {
  const browser = await chromium.connectOverCDP(config.cdpUrl);
  const context = browser.contexts()[0];
  const pages = context.pages().filter((page) => !urlFragment || page.url().includes(urlFragment));
  if (!pages.length) throw new Error(`No matching page found${urlFragment ? ` for "${urlFragment}"` : ''}`);
  const page = pages[pages.length - 1];
  const frames = [];
  for (const [index, frame] of page.frames().entries()) {
    frames.push({
      index,
      url: frame.url(),
      html: redactDom(await frame.content()),
    });
  }
  // Two outputs, because they serve different purposes:
  //
  // 1. registration/<provider>.html - the main frame, written where the registration test
  //    auto-discovers fixtures, so capturing a new provider immediately extends coverage.
  //    Previously capture only produced the JSON below, which no test could read - so every
  //    capture was dead weight and new providers silently stayed untested.
  // 2. captured/<provider>/page.json - the full multi-frame dump, for the cases where the
  //    gate lives in an iframe and the main frame alone is not enough to reproduce it.
  //    Gitignored: it is raw reference material, not a test input.
  const registrationDir = path.join(__dirname, '..', 'test', 'fixtures', 'registration');
  fs.mkdirSync(registrationDir, { recursive: true });
  const htmlPath = path.join(registrationDir, `${provider}.html`);
  const mainFrame = frames[0];
  fs.writeFileSync(htmlPath, mainFrame ? mainFrame.html : '');

  const outputDir = path.join(__dirname, '..', 'test', 'fixtures', 'captured', provider);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'page.json'), JSON.stringify({
    provider,
    capturedAt: new Date().toISOString(),
    pageUrl: page.url(),
    frames,
  }, null, 2));

  console.log(`Captured ${provider}:`);
  console.log(`  test fixture (auto-discovered by npm run test:registration): ${htmlPath}`);
  console.log(`  full frame dump (reference only):                            ${outputDir}`);
  if (frames.length > 1) {
    console.log(`  note: page had ${frames.length} frames; if the gate is inside an iframe, the`);
    console.log('        main-frame fixture may not reproduce it - check the frame dump.');
  }
  await browser.close();
})().catch((error) => {
  console.error('Fixture capture failed:', error.message);
  process.exit(1);
});
