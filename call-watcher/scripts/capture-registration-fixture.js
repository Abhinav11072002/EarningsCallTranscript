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
  const outputDir = path.join(__dirname, '..', 'test', 'fixtures', 'captured', provider);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'page.json'), JSON.stringify({
    provider,
    capturedAt: new Date().toISOString(),
    pageUrl: page.url(),
    frames,
  }, null, 2));
  console.log(`Captured sanitized fixture for ${provider}: ${outputDir}`);
  await browser.close();
})().catch((error) => {
  console.error('Fixture capture failed:', error.message);
  process.exit(1);
});
