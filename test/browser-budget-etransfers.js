'use strict';
// Display tidy-up (owner screenshots): the "Outgoing e-transfers" section no
// longer prints on the Budget page. This replaces the former proof of that
// section with a proof of its absence on the actual post-boot DOM, after
// budget-blend.js has run, across the states that used to change it. Forecast
// still publishes currentPeriodAction.outgoingETransfers (the bell's
// transaction review reads it); the figures are untouched. Fixtures are the
// invented Budget surface household plus one invented SEND E-TFR provider row;
// every request is intercepted, no server or credentials are used.
// CHROME_PATH=<Chromium> node test/browser-budget-etransfers.js
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { chromium } = require('playwright'), fx = require('./fixtures/budget-surface-data');
const root = path.join(__dirname, '..');

function servedFor(state) {
  if (state === 'unavailable') return fx.served({ unavailablePlan: true });
  const data = fx.served({ etransfer: true });
  const packet = data.liveOverlay.currentPeriodActuals;
  if (state === 'posted-only') packet.pendingCoverage = 'unknown';
  if (state === 'incomplete-truncated') packet.transactionCoverage = 'truncated';
  if (state === 'stale') packet.coverageThrough = '2026-08-19';
  return data;
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true });
  const errors = [], external = [];
  try {
    for (const width of [390, 1440]) {
      for (const state of ['complete', 'posted-only', 'incomplete-truncated', 'stale', 'unavailable']) {
        const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
        page.setDefaultTimeout(15000);
        page.on('pageerror', e => errors.push(`${width}/${state}: ${e.message}`));
        await page.route('**/*', route => {
          const u = new URL(route.request().url());
          if (u.origin !== 'http://budget.test') { external.push(u.origin); return route.abort(); }
          if (u.pathname === '/data.json') return route.fulfill({ json: servedFor(state) });
          if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) return route.fulfill({ json: null });
          const file = path.join(root, 'public', u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
          if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
          return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
        });
        await page.goto('http://budget.test/');
        await page.locator('[data-budget-surface]').waitFor();
        await page.evaluate(async () => {
          await document.fonts.ready;
          await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        });
        const found = await page.evaluate(() => ({
          section: document.querySelectorAll('[data-budget-browse="e-transfers"], .budget-browse-etransfers, .budget-etransfers-review, [data-etransfer-state], [data-etransfer-item]').length,
          text: (((el) => { el.querySelectorAll('[data-budget-detail-sheet], [data-transaction-review]').forEach(n => n.remove()); return el.textContent; })(document.body.cloneNode(true)).match(/.{20}(Outgoing e-transfers?|Coverage incomplete|Evidence unavailable|Evidence not current).{20}/g) || []).join(' // '),
        }));
        assert.equal(found.section, 0, `${width}/${state}: no e-transfer section in the post-boot DOM`);
        assert.equal(found.text, '', `${width}/${state}: no "Outgoing e-transfers" heading or status text on the page itself (the bell's transaction review is separate)`);
        await page.close();
      }
    }
    assert.deepEqual(errors, [], 'no page errors');
    assert.deepEqual(external, [], 'no external requests');
    console.log('browser-budget-etransfers: ok');
  } finally {
    await browser.close();
  }
})().catch(err => { console.error(err); process.exit(1); });
