'use strict';
// Browser-side timing beacon, in real Chromium against the real server:
// each page load sends exactly ONE beacon after its first render, and the
// server writes exactly one closed atlas-client-timing line for it.
// `node test/test-client-timing-browser.js` (skips when Playwright is absent;
// CHROME_PATH may name the Chromium binary).
//
// Failure it detects: no beacon, or more than one, per load (including after
// a reload and after later re-renders); a beacon on a forced refresh's
// reload counted twice; a body beyond the closed schema; the wrong page
// enum for the Stack page (/) or the classic Budget page (?view=classic);
// the wrong device class for a desktop or a phone context; a page error from
// the timing code; the beacon going anywhere but the same origin.
// Release decision: any failure blocks.
//
// Invented data only: test/fixtures/budget-layout-data.js as the served
// document. No provider, no household data.
let chromium;
try { require.resolve('playwright'); ({ chromium } = require('playwright')); }
catch (_) { console.log('client timing browser: skipped (Playwright not installed)'); process.exit(0); }
const assert = require('node:assert/strict');
const net = require('node:net');

const PASS = 'client-timing-browser-password-1234';
const SECRET = 'client-timing-browser-session-secret-0123456789';
let passed = 0;
const realLog = console.log;
async function check(name, fn) { await fn(); passed += 1; realLog('  ok ' + name); }
const freePort = () => new Promise(resolve => {
  const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const captured = [];
const lines = () => captured.filter(line => line.startsWith('{"type":"atlas-client-timing"')).map(line => JSON.parse(line));
const until = async (predicate, label, ms = 20000) => {
  const deadline = Date.now() + ms;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('deadline: ' + label); await new Promise(r => setTimeout(r, 50)); }
};

(async () => {
  realLog('=== browser timing beacon: real Chromium ===');
  const { createApplication } = require('../server.js');
  const app = createApplication({ env: { SITE_PASSWORD: PASS, SESSION_SECRET: SECRET },
    baseSource: async () => require('./fixtures/budget-layout-data')() });
  const port = await freePort();
  const server = await new Promise(resolve => { const s = app.listen(port, '127.0.0.1', () => resolve(s)); });
  const base = 'http://127.0.0.1:' + port;
  console.log = (...args) => { captured.push(args.map(String).join(' ')); };
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  try {
    // One browser context; records every beacon request and page error.
    async function open(contextOptions) {
      const context = await browser.newContext(contextOptions);
      const beacons = [], errors = [], external = [];
      context.on('request', request => {
        const url = new URL(request.url());
        if (url.origin !== base) external.push(url.origin);
        if (url.pathname === '/client-timing') beacons.push({ method: request.method(), body: request.postDataJSON(), url: url.href });
      });
      await context.request.post(base + '/login', { form: { password: PASS } });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      return { context, page, beacons, errors, external };
    }
    const settle = () => new Promise(r => setTimeout(r, 750));
    const closedBody = body => {
      assert.deepEqual(Object.keys(body).sort(), ['device', 'ms', 'page']);
      assert.deepEqual(Object.keys(body.ms).sort(), ['compute', 'fetch', 'render', 'total']);
      for (const value of Object.values(body.ms)) assert.ok(Number.isInteger(value) && value >= 0, 'whole ms: ' + value);
      assert.ok(body.ms.total >= body.ms.fetch, 'total covers the fetch');
    };

    await check('the Stack page (/) on a desktop: one beacon per load, one closed line each, also after a reload', async () => {
      const s = await open({ viewport: { width: 1440, height: 900 } });
      const before = lines().length;
      await s.page.goto(base + '/');
      await s.page.locator('#stack-root [data-stack-period]').first().waitFor();
      await until(() => s.beacons.length >= 1, 'first beacon');
      // A later re-render (the theme control) sends nothing more.
      await s.page.evaluate(() => window.App && window.App.rerender());
      await settle();
      assert.equal(s.beacons.length, 1, 'exactly one beacon for the load');
      assert.equal(s.beacons[0].method, 'POST');
      assert.equal(s.beacons[0].url, base + '/client-timing');
      closedBody(s.beacons[0].body);
      assert.equal(s.beacons[0].body.page, 'stack');
      assert.equal(s.beacons[0].body.device, 'desktop');
      await until(() => lines().length >= before + 1, 'server line');
      const line = lines().at(-1);
      assert.deepEqual(line, { type: 'atlas-client-timing', ...s.beacons[0].body });
      await s.page.reload();
      await s.page.locator('#stack-root [data-stack-period]').first().waitFor();
      await until(() => s.beacons.length >= 2, 'beacon after reload');
      await settle();
      assert.equal(s.beacons.length, 2, 'one more beacon for the reload');
      assert.equal(lines().length, before + 2);
      assert.deepEqual(s.errors, []);
      assert.deepEqual(s.external, []);
      await s.context.close();
    });

    await check('the classic Budget page (?view=classic): one beacon, page budget', async () => {
      const s = await open({ viewport: { width: 1440, height: 900 } });
      await s.page.goto(base + '/?view=classic');
      await s.page.locator('.budget-step-summary').first().waitFor();
      await until(() => s.beacons.length >= 1, 'beacon');
      await settle();
      assert.equal(s.beacons.length, 1);
      closedBody(s.beacons[0].body);
      assert.equal(s.beacons[0].body.page, 'budget');
      assert.ok(s.beacons[0].body.ms.compute > 0, 'Forecast compute was measured');
      assert.deepEqual(s.errors, []);
      await s.context.close();
    });

    await check('a phone context: device mobile', async () => {
      const s = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      await s.page.goto(base + '/');
      await s.page.locator('#stack-root [data-stack-period]').first().waitFor();
      await until(() => s.beacons.length >= 1, 'beacon');
      await settle();
      assert.equal(s.beacons.length, 1);
      assert.equal(s.beacons[0].body.device, 'mobile');
      assert.deepEqual(s.errors, []);
      await s.context.close();
    });

    await check('the timing code leaves every Forecast function exactly as it found it, and measures Stack compute', async () => {
      const s = await open({ viewport: { width: 1440, height: 900 } });
      // Snapshot every Forecast function once all scripts have run, before
      // the data fetch can resolve (the fetch is held until the snapshot).
      await s.context.route('**/data.json', async route => {
        await s.page.waitForFunction(() => window.__forecastBefore);
        return route.continue();
      });
      await s.page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => {
        window.__forecastBefore = new Map(Object.keys(window.Forecast)
          .filter(key => typeof window.Forecast[key] === 'function').map(key => [key, window.Forecast[key]]));
      }));
      await s.page.goto(base + '/');
      await s.page.locator('#stack-root [data-stack-period]').first().waitFor();
      await until(() => s.beacons.length >= 1, 'beacon');
      assert.ok(s.beacons[0].body.ms.compute > 0, 'Forecast compute was measured on the Stack page');
      const same = await s.page.evaluate(() => {
        const before = window.__forecastBefore;
        const now = Object.keys(window.Forecast).filter(key => typeof window.Forecast[key] === 'function');
        return before.size > 10 && now.length === before.size && now.every(key => window.Forecast[key] === before.get(key));
      });
      assert.equal(same, true, 'every Forecast function is the original after the first render');
      const nearDue = await s.page.evaluate(() => typeof window.Forecast.classifyCurrentPeriodTransaction?.nearDueBillCandidateHeld);
      assert.notEqual(nearDue, 'undefined', 'a function property survives');
      assert.deepEqual(s.errors, []);
      await s.context.close();
    });
  } finally {
    await browser.close();
    console.log = realLog;
    await new Promise(resolve => server.close(resolve));
  }
  realLog(`client timing browser: ${passed} checks passed`);
  process.exit(0);
})().catch(error => { console.log = realLog; console.error(error); process.exit(1); });
