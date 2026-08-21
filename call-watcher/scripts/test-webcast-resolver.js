// Exercises indirect, direct, and unknown webcast resolution against local dummy sites.
const http = require('http');
const { chromium } = require('playwright-core');
const { resolveWebcastPage } = require('../src/webcastResolver');
const { loadConfig } = require('../src/loadConfig');

const config = loadConfig();

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      if (request.url === '/landing') return response.end('<a href="/events">Events</a>');
      if (request.url === '/events') return response.end('<a href="/player">Conference</a>');
      if (request.url === '/direct') return response.end('<h1>Direct webcast player</h1>');
      response.end('<h1>Unknown landing page</h1>');
    });
    server.listen(0, () => resolve(server));
  });
}

(async () => {
  const server = await startServer();
  const port = server.address().port;
  const browser = await chromium.connectOverCDP(config.cdpUrl);
  const context = browser.contexts()[0];
  const localConfig = { knownDirectProviderDomains: ['localhost'] };
  const logger = { info: () => {}, warn: () => {} };
  const failures = [];
  try {
    const indirect = await resolveWebcastPage(context, `http://localhost:${port}/landing`, { knownDirectProviderDomains: [] }, logger);
    if (!indirect.url().endsWith('/events')) failures.push(`indirect navigation (${indirect.url()})`);
    await indirect.close();

    const direct = await resolveWebcastPage(context, `http://localhost:${port}/direct`, localConfig, logger);
    if (!direct.url().endsWith('/direct')) failures.push('direct provider');
    await direct.close();

    const unknown = await resolveWebcastPage(context, `http://localhost:${port}/unknown`, { knownDirectProviderDomains: [] }, logger);
    if (!unknown.url().endsWith('/unknown')) failures.push('unknown fallback');
    await unknown.close();
  } finally {
    server.close();
    await browser.close();
  }
  if (failures.length) throw new Error(`Resolver cases failed: ${failures.join(', ')}`);
  console.log('Webcast resolver dummy-site tests passed.');
})().catch((error) => {
  console.error('Webcast resolver test failed:', error.message);
  process.exit(1);
});
