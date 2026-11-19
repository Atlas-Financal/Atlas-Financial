'use strict';
/* Lead dispatch (ATLAS LEAD 11, 2026-11-19; #1416): the card ledger owns one closed set of reasons an unreconciled
 * card payment row may publish, with the one line the page prints for each (Forecast.CARD_PAYMENT_REASONS). The page
 * keeps no reason table of its own (bill-detail's VISA_REASONS had nine keys nothing produced). Any reason outside the
 * set publishes as 'payment-reason-unavailable', so the page never receives a code it has no line for, including the
 * qualifier-internal diagnostic codes and any future dynamic code.
 *
 * Path: invented raw Lunch Money rows -> scripts/live-plan.js fromObservation -> the served packet ->
 * Forecast.recommend (the active period's visaPaymentBackfill) -> BillDetail.visaPaymentsHtml.
 *
 * Invented world (test/fixtures/card-coverage-aggregate-world.js, a records policy with no recorded payment): an 80
 * card purchase and a -105 "PAYMENT - THANK YOU" card credit. With no record confirming its purpose, the credit is
 * published unreconciled with 'payment-intent-unconfirmed' and applied to no purchase.
 *
 * `node test/test-card-payment-reasons-closed-set.js`
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const F = require('../public/forecast');
const Detail = require('../public/bill-detail');
const { world, run } = require('./fixtures/card-coverage-aggregate-world');

let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };

const SET = F.CARD_PAYMENT_REASONS;
const FALLBACK = 'payment-reason-unavailable';
const records = { opening: { asOf: '2026-09-18', confirmed: true, currency: 'cad', fundingAccountId: 'chequing-a', purchases: [] },
  payments: [], refunds: [], reversals: [] };
const aggregate = { rule: 'aggregate-per-card-per-pay-period',
  opening: { asOf: '2026-09-18', confirmed: true, currency: 'cad', fundingAccountId: 'chequing-a', purchases: [] } };
const purchase = ['card', 80, null, 'purchase'];
const cash = ['bills', 105, null, 'cash', { payee: 'TFR-TO C/C', original_name: 'AB123 TFR-TO C/C', category_name: 'Credit Card Payment' }];
const credit = ['card', -105, null, 'credit', { payee: 'PAYMENT - THANK YOU', category_name: 'Credit Card Payment' }];
const served = (rows, policy) => {
  const s = run(world(rows, { policy }));
  const period = s.advice.defaultView.calendarPeriods[0];
  return { rows: period.visaPaymentBackfill || [], html: Detail.visaPaymentsHtml(period.visaPaymentBackfill, period.cardPurchaseCoverage) };
};

console.log('1. The set is closed and owned by the card ledger');
{
  ok(SET && Object.isFrozen(SET), 'Forecast.CARD_PAYMENT_REASONS is a frozen map');
  ok(JSON.stringify(Object.keys(SET).sort()) === JSON.stringify(['payment-intent-unconfirmed', FALLBACK]),
    'it holds exactly the published reason and the fail-closed reason', JSON.stringify(Object.keys(SET)));
  ok(Object.values(SET).every(line => typeof line === 'string' && line.length > 0 && !/\b(settled|verified|paid|confirmed)\b/i.test(line)),
    'every line states the row\'s state and claims nothing settled, verified, paid or confirmed');
  ok(SET[FALLBACK] === 'Atlas cannot say why this payment is unmatched, so it is applied to no purchase.', 'the approved fail-closed line');
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'bill-detail.js'), 'utf8');
  ok(!/VISA_REASONS/.test(page) && !/could not be reconciled/.test(page)
    && ['The payment amount is missing.', 'The card account is contradictory.', 'A credit in the window is neither a payment nor a refund.']
      .every(line => !page.includes(line)), 'the page holds no reason table and none of the retired lines');
}

console.log('2. Ledger to page: every published reason has its line (served path)');
{
  const seen = new Set();
  for (const [why, rows, policy] of [['records, credit only', [purchase, credit], records],
    ['records, unrecorded pair', [purchase, cash, credit], records], ['aggregate pair', [purchase, cash, credit], aggregate]]) {
    const x = served(rows, policy);
    for (const row of x.rows) {
      if (row.status === 'reconciled') { ok(row.reason === null, why + ': a reconciled row carries no reason'); continue; }
      seen.add(row.reason);
      ok(Object.hasOwn(SET, row.reason), why + ': its reason is in the set (' + row.reason + ')');
      ok(x.html.includes('Unreconciled — ' + SET[row.reason]), why + ': the page prints the set\'s line for it');
    }
  }
  ok(seen.has('payment-intent-unconfirmed'), 'the served path reaches payment-intent-unconfirmed', JSON.stringify([...seen]));
  // Every literal reason the card ledger writes on an unreconciled publication row is in the set.
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'forecast.js'), 'utf8');
  const literals = [...src.matchAll(/status: 'unreconciled', reason: '([a-z-]+)'/g)].map(m => m[1]);
  ok(literals.length > 0 && literals.every(code => Object.hasOwn(SET, code)), 'every unreconciled reason literal in forecast.js is in the set',
    JSON.stringify(literals));
}

console.log('3. Fail closed: any other reason publishes as the fallback, which the page prints');
{
  const base = { id: 'x', date: '2026-09-20', accountLabel: 'Invented card', status: 'unreconciled', amount: 105, purchases: [] };
  // The qualifier's diagnostic codes, a dynamic problem.code shape, and hostile or empty values.
  for (const reason of ['coverage-allocation-conflict', 'coverage-identity-ambiguous', 'coverage-reversal-allocation-conflict',
    'coverage-reversal-unconfirmed', 'coverage-payment-source-unconfirmed', 'missing-amount', '__proto__', 'toString', '', null, undefined]) {
    const row = F.visaPaymentPublication({ ...base, reason });
    ok(row.reason === FALLBACK, 'an unreconciled ' + JSON.stringify(reason) + ' publishes as ' + FALLBACK);
    ok(Detail.visaPaymentsHtml([row], null).includes('Unreconciled — ' + SET[FALLBACK]), '  the page prints the fail-closed line');
  }
  const reconciled = F.visaPaymentPublication({ ...base, status: 'reconciled', backfill: 80, cardPayment: 25 });
  ok(reconciled.reason === null, 'a reconciled row still publishes no reason');
  ok(F.visaPaymentPublication({ ...base, reason: 'payment-intent-unconfirmed' }).reason === 'payment-intent-unconfirmed', 'a reason in the set passes unchanged');
}

console.log('4. Page to ledger: every line the set holds is reachable');
{
  const reached = new Set(['payment-intent-unconfirmed', FALLBACK]);
  ok(Object.keys(SET).every(key => reached.has(key)), 'no key in the set is dead (served path for the first, fail-closed for the second)');
}

console.log(`\nAll card payment reason checks passed (${checks}).`);
