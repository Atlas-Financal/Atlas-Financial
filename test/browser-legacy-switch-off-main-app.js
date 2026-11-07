'use strict';
// Optional real-browser capture for the legacy-page switch-off (not in npm test;
// browser suites are run on demand). Boots the real server.js through the
// shared withServer harness with the invented household-path fixture (no
// captured household values), opens the main app at / for a session, and
// records:
//   - every same-origin request the main app makes, with its status;
//   - whether each owner-listed main-app function rendered its surface;
//   - Lunch Money refresh (the manual refresh control -> /data.json?refresh=force reaches
//     the data route unredirected);
//   - Talk and its endpoints for the same session.
// It fails if the main app requests any switched-off path, receives any
// redirect, throws a page error, or a listed function's surface is absent.
// Run: node test/browser-legacy-switch-off-main-app.js [--json out.json]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { withServer } = require('./test-savings-evidence-integration');
const { fixture } = require('./fixtures/household-path-data');

const SWITCHED_OFF = ['planning', 'bills', 'subscriptions', 'credit', 'records', 'deepdive']
  .flatMap(p => [`/${p}.html`, `/${p}.js`]);

// Each owner-listed function -> DOM markers the main app renders for it.
const FUNCTIONS = [
  ['Household budget', ['[data-budget-surface]', '[data-calendar-waterfall]', '[data-budget-browse="spending"]']],
  ['Savings goals', ['[data-blend-goals]', '[data-budget-savings-goals]', '[data-budget-savings-goal]']],
  ['Credit cards', ['[data-budget-card-panel]', '[data-budget-card-toggle]', '[data-budget-card-movements]']],
  ['Income', ['[data-period-income]', '[data-income-status]', '[data-income-line-amount]']],
  ['Timeline / period selector', ['[data-pay-period-swipe]']],
  ['Transaction review', ['[data-transaction-review-open]', '[data-review-item]', '[data-review-badge]']],
  ['Lunch Money refresh control', ['[data-manual-refresh]']],
];

(async () => {
  const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;
  const report = { requests: [], functions: {}, refresh: null, talk: {}, errors: [] };
  await withServer(fixture(), async server => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce' });
      const split = server.cookie.indexOf('=');
      await context.addCookies([{ name: server.cookie.slice(0, split), value: server.cookie.slice(split + 1),
        url: server.base, httpOnly: true, sameSite: 'Lax' }]);
      await context.route('**/*', route => new URL(route.request().url()).origin === server.base
        ? route.continue() : route.abort());
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      page.on('pageerror', e => report.errors.push(e.message));
      page.on('response', res => {
        const u = new URL(res.url());
        if (u.origin === server.base) report.requests.push({ method: res.request().method(),
          path: u.pathname + u.search, status: res.status(), location: res.headers().location || null });
      });
      const nav = await page.goto(server.base + '/', { waitUntil: 'load' });
      assert.equal(nav.status(), 200, 'main app loads');
      await page.locator('[data-budget-surface]').waitFor();
      await page.waitForFunction(() => !!document.querySelector('[data-pay-period-swipe]'));
      await page.waitForTimeout(1500);
      // Open every disclosure so lazily rendered panels mount too.
      await page.evaluate(() => document.querySelectorAll('details').forEach(d => { d.open = true; }));
      await page.waitForTimeout(500);
      for (const [name, selectors] of FUNCTIONS) {
        const counts = {};
        for (const s of selectors) counts[s] = await page.locator(s).count();
        report.functions[name] = counts;
      }
      // Lunch Money refresh: the incumbent manual control (fixture overlay, no provider call).
      const refresh = page.locator('[data-manual-refresh]').first();
      if (await refresh.count()) {
        const waitRefresh = page.waitForResponse(r => r.url().includes('/data.json?refresh=force'), { timeout: 15000 })
          .catch(() => null);
        await refresh.click({ force: true }).catch(e => report.errors.push('refresh click: ' + e.message));
        const r = await waitRefresh;
        report.refresh = r ? r.status() : 'no refresh request observed';
        await page.waitForTimeout(1000);
      }
      // Talk and its endpoints, same session (assistant packet is server-side and
      // covered in npm test; nothing here touches it).
      for (const p of ['/talk.html', '/talk.js', '/talk/capability', '/talk/context']) {
        const res = await fetch(server.base + p, { headers: { cookie: server.cookie }, redirect: 'manual' });
        report.talk[p] = res.status;
      }
    } finally {
      await browser.close();
    }
  });

  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2));
  const offHits = report.requests.filter(r => SWITCHED_OFF.includes(r.path.split('?')[0].toLowerCase()));
  const redirects = report.requests.filter(r => r.status >= 300 && r.status < 400);
  // The fixture overlay has no live provider, so a forced refresh answers the
  // data route's own 503; the provider-mocked refresh path is proved by
  // browser-observation-memory.js. Here it must reach /data.json, unredirected.
  const failed = report.requests.filter(r => r.status >= 400 && !r.path.startsWith('/data.json?refresh=force'));
  console.log('requests:', report.requests.map(r => `${r.method} ${r.path} ${r.status}`).join('\n  '));
  console.log('functions:', JSON.stringify(report.functions, null, 2));
  console.log('refresh:', report.refresh, 'talk:', JSON.stringify(report.talk));
  assert.deepEqual(offHits, [], 'main app requests no switched-off path');
  assert.deepEqual(redirects, [], 'main app receives no redirect');
  assert.deepEqual(failed, [], 'every main-app request succeeds');
  assert.deepEqual(report.errors, [], 'no page errors');
  for (const [name, counts] of Object.entries(report.functions)) {
    assert.ok(Object.values(counts).some(n => n > 0), `${name} surface is present`);
  }
  assert.ok(report.refresh === 200 || report.refresh === 503,
    'Lunch Money refresh reaches the data route (200, or the fixture overlay\'s no-provider 503)');
  for (const [p, s] of Object.entries(report.talk)) assert.equal(s, 200, `${p} is served`);
  console.log('PASS main app functions unaffected by the legacy-page switch-off');
})().catch(err => { console.error(err); process.exit(1); });
