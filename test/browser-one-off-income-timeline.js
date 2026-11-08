'use strict';
// #823 browser proof: a one-off income entry reaches the Budget timeline
// strip for exactly its named future pay period, and removing it restores
// the strip. Invented fixture (the Part A fixture of
// test-one-off-income-period.js): every period is Dale 1000 − rent 400 −
// household 300 = $300.00. A one-off 250 (estimated) dated 2026-11-10 makes
// Nov 6–19 1250 − 400 − 300 = $550.00, marked ≈ estimated; every other
// period still prints $300.00. Expected strings are hand-written.
// NODE_PATH=<Playwright modules> CHROME_PATH=<Chromium> node test/browser-one-off-income-timeline.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.join(__dirname, '..');

const AS_OF = '2026-10-09';
function data(withOneOff) {
  const income = [{ id: 'payroll', label: 'Invented employer payroll', frequency: 'biweekly',
    anchor: '2026-08-14', amount: 1000, confidence: 'confirmed' }];
  if (withOneOff) {
    income.push({ id: 'synthetic-one-off', label: 'Synthetic one-off income', frequency: 'once',
      date: '2026-11-10', amount: 250, confidence: 'estimated', incomeClass: 'other' });
  }
  return {
    meta: { asOf: AS_OF, title: 'Invented one-off income' },
    accounts: [], debts: [], revolvingExtra: [],
    plan: {
      defaults: { targetBuffer: 0, extraDebtMonthly: 0 },
      windowDays: 91,
      startingCash: { breakdown: [{ id: 'chequing-a', label: 'Invented bills', value: 2000,
        class: 'spendable', evidenceDate: AS_OF, confidence: 'confirmed' }] },
      opening: { asOf: AS_OF, representedEvents: [] },
      nextDollar: { policy: 'true-surplus-highest-interest', provenance: 'owner-stated' },
      income,
      bills: [{ id: 'synthetic-rent', label: 'Synthetic rent', amount: 400, frequency: 'biweekly',
        anchor: '2026-08-14', confidence: 'confirmed', payingAccount: 'chequing-a' }],
      obligations: [], commitments: [], groups: [], funding: { options: [] },
      budget: { categories: [{ id: 'groceries', label: 'Groceries', class: 'essential',
        plannedPayday: 300, confidence: 'confirmed', from: [] }] },
    },
  };
}

async function strip(browser, served) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.origin !== 'http://budget.test') return route.abort();
    if (u.pathname === '/data.json') return route.fulfill({ json: served });
    if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) {
      return route.fulfill({ json: null });
    }
    const file = path.join(root, 'public', u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
    if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ body: fs.readFileSync(file),
      contentType: file.endsWith('.js') ? 'application/javascript'
        : file.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  await page.goto('http://budget.test/');
  await page.locator('[data-bad-timeline] li').first().waitFor({ state: 'attached' });
  const rows = await page.evaluate(() => [...document.querySelectorAll('[data-bad-timeline] li')].map(li => ({
    start: li.getAttribute('data-bad-timeline-start'),
    trust: li.getAttribute('data-bad-term-trust'),
    amount: li.querySelector('[data-bad-term-amount]')?.textContent || '',
    text: li.textContent,
  })));
  await page.close();
  assert.deepEqual(errors, [], 'no page errors');
  return rows;
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true, args: ['--no-sandbox'] });
  try {
    const FUTURE = ['2026-10-23', '2026-11-06', '2026-11-20', '2026-12-04', '2026-12-18'];
    const pick = (rows, start) => rows.find(r => r.start === start);
    const base = await strip(browser, data(false));
    for (const start of FUTURE) {
      assert.equal(pick(base, start)?.amount, '$300.00', 'baseline ' + start + ' prints $300.00');
    }
    const withOne = await strip(browser, data(true));
    const nov6 = pick(withOne, '2026-11-06');
    assert.equal(nov6?.amount, '$550.00', 'Nov 6–19 prints $550.00 with the one-off');
    assert.equal(nov6.trust, 'estimated', 'the one-off period is marked estimated');
    assert.ok(/≈/.test(nov6.text), 'the estimate mark prints: ' + nov6.text);
    for (const start of FUTURE.filter(s => s !== '2026-11-06')) {
      assert.equal(pick(withOne, start)?.amount, '$300.00', start + ' still prints $300.00');
    }
    const removed = await strip(browser, data(false));
    assert.deepEqual(removed, base, 'removing the entry restores the strip exactly');
  } finally {
    await browser.close();
  }
  console.log('PASS one-off income timeline: the one-off reaches only its named pay period on the strip ($550.00, ≈ estimated), neighbours stay $300.00, removal restores the strip');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
