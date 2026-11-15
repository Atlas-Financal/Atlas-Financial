'use strict';
// Money out, to confirm, on the Budget face (owner-approved audit, 1.0). Real Budget page,
// invented data only (test/fixtures/money-out-worlds.js: the Budget surface household plus one
// $400 debit filed as Transfer with no proven other side). The hero face prints income, bills,
// household, the money-out term and the remainder, and the printed parts sum to the printed
// total. A second check proves the same face code prints a published savings-item term, so a
// face never prints parts that do not sum ("$1,400 - $0 - $300 = -$1,900" before): it adds a
// copy of the published term row to the block and repaints through the page's own observer.
// NODE_PATH=<Playwright modules> CHROME_PATH=<Chromium> node test/browser-money-out-face.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { world } = require('./fixtures/money-out-worlds');
const root = path.join(__dirname, '..');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  const errors = [], external = [], writes = [];
  let checks = 0;
  const ok = (cond, label, detail) => { assert.ok(cond, label + (detail ? ' - ' + detail : '')); checks++; };
  try {
    const open = async (data, width, wrap = '') => {
      const page = await browser.newPage({ viewport: { width, height: 1100 }, colorScheme: 'light', reducedMotion: 'reduce' });
      page.on('pageerror', err => errors.push(err.message));
      await page.route('**/*', route => {
        const u = new URL(route.request().url());
        if (route.request().method() !== 'GET') { writes.push(u.pathname); return route.abort(); }
        if (u.origin !== 'http://budget.test') { external.push(u.origin); return route.abort(); }
        if (u.pathname === '/data.json') return route.fulfill({ json: data });
        if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) return route.fulfill({ json: null });
        const file = path.join(root, 'public', u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
        if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
        if (u.pathname === '/forecast.js' && wrap) return route.fulfill({ body: fs.readFileSync(file, 'utf8') + wrap, contentType: 'application/javascript' });
        return route.fulfill({ body: fs.readFileSync(file),
          contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
      });
      await page.goto('http://budget.test/');
      await page.locator('[data-budget-surface]').waitFor();
      await page.locator('[data-blend-rings]').waitFor();
      await page.locator('[data-blend-term="balanceAfterDeductions"]').first().waitFor({ state: 'attached' });
      return page;
    };
    const dollars = text => Math.round(Number(String(text).replace(/[^0-9.\-]/g, '')) * 100);
    const face = page => page.evaluate(() => {
      const t = selector => (document.querySelector(selector)?.textContent || '').replace(/\s+/g, ' ').trim();
      return {
        income: t('[data-operating-question="02"] [data-blend-term="periodIncome"]'),
        bills: t('[data-operating-question="04"] [data-blend-term="assignedBills"]'),
        household: t('[data-operating-question="06"] > .budget-step-value > [data-blend-term="householdBudgetHold"]')
          || t('[data-operating-question="06"] [data-blend-term="householdBudgetHold"]'),
        moneyOut: t('[data-blend-term-extra="moneyOutToConfirm"] [data-blend-term]'),
        moneyOutLabel: t('[data-blend-term-extra="moneyOutToConfirm"] .blend-term-label'),
        item: t('[data-blend-term-extra="savingsItemSpending"] [data-blend-term]'),
        result: t('[data-blend-term="balanceAfterDeductions"]'),
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      };
    });
    for (const width of [390, 320]) {
      const page = await open(world([{ category: 'transfer', amount: 400 }]), width);
      const f = await face(page);
      ok(f.moneyOut && /Money out, to confirm/.test(f.moneyOutLabel), width + ': the face prints the money-out term with its label', JSON.stringify(f));
      ok(dollars(f.income) - dollars(f.bills) - dollars(f.household) - dollars(f.moneyOut) === dollars(f.result),
        width + ': the printed parts sum to the printed total', JSON.stringify(f));
      ok(!f.overflow, width + ': no horizontal overflow');
      if (width === 390) await page.locator('.blend-hero').first().screenshot({ path: '/tmp/atlas-money-out-face-390.png' });
      await page.close();
    }
    // Savings-item term. The page prints what Forecast publishes; to exercise the face with a
    // published item term (linked savings-item purchase) the published terms are given one: the
    // item term 300 and the remainder reduced by the same 300, so the identity still closes.
    {
      const wrap = `
;(() => { const original = Forecast.recommend; Forecast.recommend = function (...args) {
  const advice = original.apply(this, args);
  for (const view of advice.payPeriodViews || []) {
    const t = view.timelineRole === 'current' && view.predictedEndingBalanceTerms;
    if (!t || t.closes !== true) continue;
    t.savingsItemSpending = 300;
    t.balanceAfterDeductions = Math.round((t.balanceAfterDeductions - 300) * 100) / 100;
    view.balanceAfterDeductions = t.balanceAfterDeductions;
  }
  return advice; }; })();`;
      const page = await open(world([{ category: 'transfer', amount: 400 }]), 390, wrap);
      const f = await face(page);
      ok(f.item === '$300.00', 'a published savings-item term is printed on the face', JSON.stringify(f));
      ok(dollars(f.income) - dollars(f.bills) - dollars(f.household) - dollars(f.item) - dollars(f.moneyOut) === dollars(f.result),
        'income - bills - household - savings items - money out = the printed remainder', JSON.stringify(f));
      await page.close();
    }
    assert.deepEqual(errors, [], 'no page errors');
    assert.deepEqual(external, [], 'no external requests');
    assert.deepEqual(writes, [], 'no writes');
    console.log(`PASS money out to confirm on the Budget face: ${checks} checks`);
  } finally { await browser.close(); }
})().catch(err => { console.error(err); process.exit(1); });
