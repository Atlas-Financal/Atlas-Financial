'use strict';
/* Browser proof: the live page prints the stale-card estimate note beside
 * every figure built from a stale card balance (Forecast.cardBalanceFreshness,
 * #1305), and nothing when the balance is current.
 *
 * Invented data only, served to the real public/ page. One invented card with
 * statement close day 17, as-of 2026-09-20 (cycle from 2026-09-17):
 *   stale:   balance dated 2026-09-10 -> note "estimate — Invented card balance
 *            as of …, before this statement cycle"
 *   current: balance dated 2026-09-18 -> no note anywhere
 *
 * CHROME_PATH=<Chromium> node test/browser-stale-card-balance-note.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let chromium;
try { ({ chromium } = require('playwright')); } catch (_) {
  console.log('SKIP browser-stale-card-balance-note: playwright is not installed.');
  process.exit(0);
}
const root = path.join(__dirname, '..');
const AS_OF = '2026-09-20';
const data = balanceAsOf => ({
  meta: { asOf: AS_OF }, accounts: [], revolvingExtra: [],
  debts: [{ id: 'travelvisa', label: 'Invented card', structure: 'Revolving', secured: false,
    balance: 400, pending: 0, rate: 19.99, limit: 2000, payment: 25, statementCloseDay: 17,
    confidence: 'confirmed', balanceAsOf }],
  plan: {
    defaults: { targetBuffer: 0 }, windowDays: 60,
    startingCash: { breakdown: [{ id: 'chequing-a', label: 'Invented chequing', value: 2500, class: 'spendable' }] },
    opening: { asOf: AS_OF },
    nextDollar: { policy: 'true-surplus-highest-interest', provenance: 'owner-stated' },
    income: [{ id: 'payroll', label: 'Invented payroll', frequency: 'biweekly', anchor: '2026-09-18', amount: 3000, confidence: 'confirmed' }],
    bills: [], obligations: [], commitments: [],
    budget: { categories: [{ id: 'groceries', label: 'Invented groceries', plannedWeekly: 100 }] },
  },
});

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  try {
    for (const [label, balanceAsOf] of [['stale', '2026-09-10'], ['current', '2026-09-18']]) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 1100 }, reducedMotion: 'reduce' });
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', route => {
        const u = new URL(route.request().url());
        if (u.origin !== 'http://budget.test') return route.abort();
        if (u.pathname === '/data.json') return route.fulfill({ json: data(balanceAsOf) });
        if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) return route.fulfill({ json: null });
        const file = path.join(root, 'public', u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
        if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ body: fs.readFileSync(file),
          contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
      });
      await page.goto('http://budget.test/');
      await page.waitForFunction(() => (document.getElementById('snapshot-tiles') || {}).textContent);
      const text = await page.evaluate(() => ({
        tiles: document.getElementById('snapshot-tiles').textContent.replace(/\s+/g, ' '),
        hero: (document.getElementById('hero-tiles') || document.body).textContent.replace(/\s+/g, ' '),
        score: (document.getElementById('score-note') || {}).textContent || '',
      }));
      // The visible Budget surface (not the hidden diagnostics section): the
      // Credit cards strip's row for the stale card.
      const row = page.locator('#operating-surface-body [data-budget-card-toggle="travelvisa"]');
      const rowText = (await row.count()) ? (await row.first().innerText()).replace(/\s+/g, ' ') : '';
      if (label === 'stale') {
        assert.equal(await row.first().isVisible(), true, 'stale: the card row is visible on the Budget');
        assert.match(rowText, /estimate · as of /, 'stale: the visible card row says estimate · as of <date>');
      } else {
        assert.doesNotMatch(rowText, /estimate/, 'current: the visible card row carries no estimate');
      }
      const note = /estimate — Invented card balance as of [^,]+, before this statement cycle/;
      if (label === 'stale') {
        assert.match(text.tiles, /Consumer debt[\s\S]*estimate — Invented card balance as of/, 'stale: Consumer debt tile carries the note');
        assert.match(text.tiles, /Credit left, everywhere[\s\S]*estimate — Invented card balance as of/, 'stale: Credit left tile carries the note');
        assert.match(text.tiles, note, 'stale: the note names the card and its balance date');
        assert.match(text.score, /Estimate: Invented card balance as of/, 'stale: the debt scoreboard says its lines are walked from an estimate');
      } else {
        assert.doesNotMatch(text.tiles + text.score + text.hero, /estimate — |Estimate: Invented card/, 'current: no stale-card note anywhere');
      }
      assert.deepEqual(errors, [], `${label}: no page errors`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
  console.log('Stale card balance note: browser checks passed.');
})().catch(err => { console.error(err); process.exit(1); });
