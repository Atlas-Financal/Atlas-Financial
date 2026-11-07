'use strict';
// Real authenticated Budget/Info with invented observations, never provider writes.
// NODE_PATH=<playwright> CHROME_PATH=<chromium> node test/browser-bills-recorded-payment.js
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { chromium } = require('playwright');
const { assertTypedBillFilters } = require('./helpers/typed-bill-filter-proof');
const { fixture, sent, NOW } = require('./test-bills-recorded-payment');
const { withServer } = require('./test-savings-evidence-integration');
const out = process.env.ATLAS_BUDGET_SCREENSHOTS_DIR || path.join(require('node:os').tmpdir(), 'atlas-recorded-bills');
const cases = [
  ['complete', [sent()], true, 'Money sent'],
  ['exact', [sent({ amount: 47.39 })], true, 'Money sent'],
  ['conflicting-allocation', [sent(), sent({ amount: 1 })], false, 'Payment allocation unconfirmed'],
  ['conflicting-purpose', [sent(), sent({ intent: 'purchase-backfill' })], false, 'Payment allocation unconfirmed'],
  ['conflicting-settled', [sent({ cashIncludedAsOf: NOW }), sent({ amount: 1 })], true, 'Payment allocation unconfirmed'],
  ['partial', [sent({ amount: 46.38 })], false, 'Partial payment sent'],
  ['partial-settled', [sent({ amount: 23.11, cashIncludedAsOf: NOW })], true, 'Partial payment sent'],
  ['estimated-settled', [sent({ cashIncludedAsOf: NOW })], true, 'minimum amount unconfirmed'],
  ['pending', [sent({ pending: true })], false, null],
  ['backfill', [sent({ intent: 'purchase-backfill' })], false, null],
  ['unknown-intent', [sent({ intent: 'unconfirmed' })], false, null],
  ['not-confirmed', [sent({ confirmed: false })], false, null],
  ['future-send', [sent({ postedOn: '2026-10-06' })], false, null],
  ['absent', null, false, null],
  ['estimated-minimum', [sent()], false, 'minimum amount unconfirmed'],
];
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const errors = [], states = []; let checks = 0;
  function eq(a, b, message) { assert.deepEqual(a, b, message); checks++; }
  function ok(a, message) { assert.ok(a, message); checks++; }
  try {
    for (const [name, records, paid, qualifier] of cases) {
      const x = fixture(records);
      const estimated = name === 'estimated-minimum' || name === 'estimated-settled';
      const settled = name.endsWith('-settled');
      if (estimated) delete x.data.plan.obligations[0].statementOccurrences;
      if (settled) x.data.plan.opening.representedEvents.push({ id: 'triangle', date: '2026-10-07', effectiveAsOf: NOW });
      x.map = x.accountMap;
      x.payload.fetchedAt = NOW + 'T18:00:00Z';
      x.payload.accounts.forEach(a => a.updated_at = NOW + 'T17:00:00Z');
      x.payload.accounts[0].balance = 785.17;
      x.payload.transactions = [];
      x.payload.transactionWindow = { startDate: '2026-09-25', endDate: NOW, complete: true, hasMore: false, truncated: false };
      await withServer(x, async server => {
        for (const width of [1440, 390, 320]) {
          const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce', colorScheme: width === 390 ? 'dark' : 'light' });
          const [cookieName, cookieValue] = server.cookie.split('=');
          await context.addCookies([{ name: cookieName, value: cookieValue, url: server.base, httpOnly: true }]);
          const page = await context.newPage();
          page.on('pageerror', e => errors.push(e.message));
          await page.goto(server.base + '/');
          await page.locator('[data-budget-surface]').waitFor();
          const bills = page.locator('[data-budget-browse="bills"]');
          const due = estimated ? '2026-10-07' : '2026-10-08';
          const row = bills.locator(`[data-budget-bill-open="triangle"][data-budget-bill-date="${due}"]`);
          await row.waitFor({ state: 'attached' });
          const triangleState = paid ? 'paid' : ['conflicting-allocation', 'conflicting-purpose', 'partial', 'estimated-minimum'].includes(name) ? 'check' : 'due';
          if (!await row.isVisible()) {
            const reveal = bills.locator(`[data-budget-bill-filter="${triangleState}"]`);
            await reveal.focus(); await page.keyboard.press('Enter');
          }
          await row.waitFor();
          const text = await row.innerText();
          eq(await bills.locator('[data-budget-bill-bucket="paid"] [data-budget-bill-open="triangle"]').count(), paid ? 1 : 0, 'full posted action alone belongs in household Paid bucket');
          if (qualifier) ok(text.includes(qualifier));
          const amazon = bills.locator('[data-budget-bill-open="mbna"], [data-budget-bill-open="mbna-aug31"]');
          eq(await amazon.count(), 2, 'distinct Amazon cycles retained');
          const amazonText = (await amazon.allInnerTexts()).join('\n');
          ok(amazonText.includes('earlier August statement'));
          ok(amazonText.includes('September minimum'));
          await row.focus(); await page.keyboard.press('Enter');
          const info = await page.locator('[data-budget-detail-body]').innerText();
          if (qualifier) {
            if (name.startsWith('conflicting-')) {
              ok(/Payment allocation unconfirmed/.test(info));
              ok(!/Paid - money sent|Money sent\s+\$/.test(info));
              ok(new RegExp('Lender minimum confirmation\\s+' + (name === 'conflicting-settled' ? 'Confirmed' : 'Not confirmed')).test(info));
            } else {
              ok(/Money sent/.test(info));
              ok(new RegExp('Lender minimum confirmation\\s+' + (settled ? 'Confirmed' : 'Not confirmed')).test(info));
              ok(new RegExp('Included in cash opening\\s+' + (settled ? 'Confirmed' : 'Not confirmed')).test(info));
            }
            ok(!/invented-recorded-send/.test(info));
          }
          await page.keyboard.press('Escape');
          eq(await row.evaluate(n => n === document.activeElement), true, 'Info returns keyboard focus to exact occurrence');
          // The two earlier statement cycles lack settlement evidence. The
          // original paid flags and literal receipt scenarios classify Triangle.
          const expected = { check: ['mbna-aug31@2026-08-31', 'mbna@2026-09-30'], due: [], paid: [], pending: [], unknown: [] };
          expected[triangleState].push('triangle@' + due);
          await assertTypedBillFilters(page, bills, expected);
          const body = await page.locator('body').innerText();
          ok(!/NaN|undefined/.test(body));
          if (qualifier) ok(/unconfirmed|unknown|unavailable/i.test(body), 'issuer/cash hold remains visible');
          await bills.screenshot({ path: path.join(out, name + '-' + width + '.png') });
          states.push({ name, width, paid, row: text, info });
          await context.close();
        }
      });
    }
    eq(errors, []);
    fs.writeFileSync(path.join(out, 'browser-results.json'), JSON.stringify({ checks, pages: states.length, errors, states }, null, 2));
    console.log('PASS recorded Bills browser:', checks, 'assertions;', states.length, 'authenticated desktop/mobile pages; zero page errors');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
