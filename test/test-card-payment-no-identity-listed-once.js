'use strict';
/* Lead ruling (ATLAS LEAD 11, 2026-11-19; Grok Bot agreed, rule 17, Plan #6): a posted chequing debit filed
 * "Credit card payment" with no card identity (no payee identity, no "card payment:" note, no group) is money out,
 * held To confirm once by #1388's held reader, settling no card minimum. Since #1388 the money is right; it was also
 * asked a second time in the card drawer ("To confirm: which card did this pay?"). Now it is listed once: the card
 * ledger keeps its estimate basis and trust, counts the row as listed under To confirm, and does not ask again. A
 * row the held reader does not hold (Savings, an earlier pay period) keeps its card question: nothing leaves both.
 *
 * Path: invented raw Lunch Money rows -> scripts/live-plan.js fromObservation -> the served packet ->
 * Forecast.recommend (card coverage, the active calendar period's held list, From-today funding) -> BillDetail's
 * card drawer.
 *
 * Invented world (test/fixtures/card-coverage-aggregate-world.js, payDownOnly [mbna], an MBNA 25 minimum due on the
 * as-of 2026-09-20, active pay period 2026-09-18..10-01): Bills 500, groceries 150. By hand:
 *   - no-identity 60 from Bills: available now = (500 - 60) - 25 minimum held - 150 = 265; Balance After Deductions
 *     = 1000 - 25 - 150 - 60 held = 765; the minimum stays to-confirm (covered 0).
 *   - an identified MBNA 40 beside it: the 40 covers the 25 minimum (15 beyond); available = (500 - 100) - 150 = 250;
 *     Balance After Deductions = 1000 - 25 - 150 - 60 held - 15 beyond = 750.
 *   - no-identity 60 from Savings: Bills untouched, available = 500 - 25 - 150 = 325; not held (Savings).
 *   - no-identity 60 in the earlier pay period (as of 2026-10-05, active period 10-02..10-15): available 265; it is
 *     not in this period's held list.
 * Every figure, the trust and the estimate basis above are the values main b2c634ea publishes for the same worlds;
 * only the active pay period's card-drawer listing changes, derived from that period's own held rows (lead, #1401).
 *
 * `node test/test-card-payment-no-identity-listed-once.js`
 */
const assert = require('node:assert/strict');
const { world, run } = require('./fixtures/card-coverage-aggregate-world');
const Detail = require('../public/bill-detail');

let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };

const policy = { rule: 'aggregate-per-card-per-pay-period', payDownOnly: ['mbna'],
  opening: { asOf: '2026-09-18', confirmed: true, currency: 'cad', fundingAccountId: 'chequing-a', purchases: [] } };
const plain = (account, amount, date) => [account, amount, date, 'cash', { payee: 'Invented card co', category_name: 'Credit Card Payment' }];
const identified = amount => ['bills', amount, null, 'cash', { payee: 'MBNA PAYMENT', category_name: 'Credit Card Payment' }];
// The page's card drawer reads the active pay period's cardPurchaseCoverage (public/plan.js), beside that period's
// held list (heldOutflowsToConfirm): the listing is derived from those held rows, never recomputed.
function serve(rows, extra = {}) {
  const s = run(world(rows, { card: 'mbna', policy, ...extra }));
  const period = s.advice.defaultView.calendarPeriods[0];
  const held = period.heldOutflowsToConfirm;
  const coverage = period.cardPurchaseCoverage;
  return { s, coverage, ledger: s.coverage, available: s.period.fromTodayFunding.availableNow,
    afterDeductions: s.advice.defaultView.predictedEndingBalance,
    heldRows: held && Array.isArray(held.recon) ? held.recon.map(r => [r.date, r.amount]) : [],
    asked: (coverage.toConfirm || []).map(r => [r.date, r.amount]),
    listed: coverage.toConfirmListedUnderHeld || 0,
    minimum: (coverage.minimumCoverage || []).map(m => [m.covered, m.status]),
    drawer: Detail.visaPaymentsHtml(period.visaPaymentBackfill, coverage) };
}
// Nothing leaves both lists: every row the card ledger questions is either still asked in the period drawer or in
// the period's held list, and the drawer's listed count is exactly the ones in the held list.
const nothingLost = (x, why) => {
  const ledgerRows = (x.ledger.toConfirm || []).map(r => [r.date, r.amount]);
  const key = r => r.join('|');
  const asked = new Set(x.asked.map(key)), held = new Set(x.heldRows.map(key));
  ok(ledgerRows.every(r => asked.has(key(r)) || held.has(key(r)))
    && ledgerRows.filter(r => !asked.has(key(r))).length === x.listed,
  why + ': nothing leaves both lists', JSON.stringify([ledgerRows, x.asked, x.heldRows, x.listed]));
};
const once = (x, date, amount) => x.heldRows.filter(r => r[0] === date && r[1] === amount).length
  + x.asked.filter(r => r[0] === date && r[1] === amount).length;

console.log('1. A no-identity Bills debit is listed once, under To confirm');
{
  const x = serve([plain('bills', 60, null)]);
  ok(once(x, '2026-09-20', 60) === 1 && x.heldRows.length === 1 && x.asked.length === 0 && x.listed === 1,
    'it is in the Budget To confirm list and is not asked again in the card drawer', JSON.stringify([x.heldRows, x.asked, x.listed]));
  nothingLost(x, 'Bills no-identity');
  ok(x.coverage.trust === 'estimated' && x.coverage.estimateBasis === 'card-payment-destination-unconfirmed',
    'the card ledger keeps its estimate basis and trust (no tag moves)');
  ok(x.available === 265 && x.afterDeductions === 765 && JSON.stringify(x.minimum) === '[[0,"to-confirm"]]',
    'figures unchanged: available 265, Balance After Deductions 765, the minimum held and not settled',
    JSON.stringify([x.available, x.afterDeductions, x.minimum]));
  ok(/1 card payment whose card is not confirmed is listed under To confirm\./.test(x.drawer)
    && !/which card did this pay\?/.test(x.drawer), 'the card drawer points to To confirm instead of asking', x.drawer.slice(0, 300));
}

console.log('2. Beside an identified MBNA payment');
{
  const x = serve([plain('bills', 60, null), identified(40)]);
  ok(once(x, '2026-09-20', 60) === 1 && x.asked.length === 0 && x.listed === 1, 'the no-identity row is listed once');
  ok(JSON.stringify(x.minimum) === '[[25,"covered-by-payment"]]' && x.available === 250 && x.afterDeductions === 750,
    'the identified 40 still covers the 25 minimum; available 250, Balance After Deductions 750',
    JSON.stringify([x.minimum, x.available, x.afterDeductions]));
  ok(!x.heldRows.some(r => r[1] === 40), 'the identified payment is never held');
  nothingLost(x, 'beside an identified payment');
}

console.log('3. A row the held reader does not hold keeps its card question');
{
  const savings = serve([plain('savings', 60, null)], { savingsOpening: 500 });
  ok(savings.heldRows.length === 0 && JSON.stringify(savings.asked) === '[["2026-09-20",60]]' && savings.listed === 0,
    'from Savings: not held, so the drawer still asks which card it paid', JSON.stringify([savings.heldRows, savings.asked]));
  ok(savings.available === 325 && /which card did this pay\?/.test(savings.drawer), 'available 325; the question prints');
  nothingLost(savings, 'Savings');
  const earlier = serve([plain('bills', 60, '2026-09-25')], { asOf: '2026-10-05' });
  ok(earlier.heldRows.length === 0 && JSON.stringify(earlier.asked) === '[["2026-09-25",60]]' && earlier.listed === 0,
    'an earlier pay period\'s row is not in this period\'s held list, so the drawer still asks', JSON.stringify([earlier.heldRows, earlier.asked]));
  ok(earlier.available === 265, 'available 265');
  nothingLost(earlier, 'earlier pay period');
}

console.log('4. The card ledger itself is unchanged; only the period drawer\'s listing is derived');
{
  const x = serve([plain('bills', 60, null)]);
  ok(JSON.stringify((x.ledger.toConfirm || []).map(r => [r.date, r.amount])) === '[["2026-09-20",60]]'
    && x.ledger.toConfirmListedUnderHeld === undefined,
  'the advice-level ledger still lists the row (the assistant and operating counts read it, unchanged)');
  ok(x.listed + x.asked.length === 1, 'the period drawer: asked plus listed under To confirm is 1');
  // A held row the period does not list (none held): nothing is dropped.
  const none = serve([plain('savings', 60, null)], { savingsOpening: 500 });
  ok(none.asked.length === 1 && none.listed === 0, 'with no held rows the drawer is untouched');
}

console.log(`\nAll no-identity card payment listing checks passed (${checks}).`);
