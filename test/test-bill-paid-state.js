'use strict';
/* Stack Wallet A3: each published bill row carries one Paid / Not paid word, `paidState` (owner decision, Dale, F2 on #821:
 * "Not paid" until a payment shows up, because autopay dates move; state table relayed by ATLAS LEAD 11).
 *
 *   paid      payment evidence only: a seen payment (Paid, Paid with an excess, Partly paid), a payment pending, money sent
 *             toward it (Planned · Money sent; To confirm · Payment allocation unconfirmed; Partly paid · Rest unknown);
 *   not-paid  no payment seen: Estimated · Trusted on due date (not seen), To confirm · Inside opening balance, To confirm with
 *             the due date passed and nothing seen, Needs a date, Due, Not paid, Status unavailable;
 *   carried   Carried to this pay period: not listed.
 *
 * Each hand-written expected word comes from the bill's evidence. Real
 * observed worlds also boot the Stack and select the occurrence on its Bills
 * card. A row can have seen payment without its amount being confirmed in full.
 * The card's Paid check and its paid total use the latter verdict.
 * Invented inputs only. The posted-plus-pending-copy case is protected by 6.19.
 *
 * `node test/test-bill-paid-state.js`
 */
const assert = require('node:assert/strict');
const test = require('node:test');
const { loadStackPage } = require('./lib/budget-page-harness');
const F = require('../public/forecast.js');
const H = require('./acceptance/harness.js');

let checks = 0, failures = 0;
const ok = (cond, label, detail = '') => {
  checks++;
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

console.log('hand-written grades for the published evidence states');
const base = { id: 'x', label: 'Invented bill', kind: 'obligation', date: '2026-10-12', planned: 90, amount: 90 };
const CASES = [
  ['Carried to this pay period', 'carried', { status: 'carried', settlement: 'carried' }],
  ['Payment pending', 'paid', { status: 'pending', settlement: 'upcoming', paymentPending: true }],
  ['Partly paid · 50 still to pay', 'paid', { status: 'PAID', settlement: 'represented', actual: 40, paymentState: 'partly-paid',
    shortfall: 50, shortfallTrust: 'calculated' }],
  ['Partly paid · ≈ estimated rest', 'paid', { status: 'PAID', settlement: 'represented', paymentState: 'partly-paid', shortfall: 5,
    shortfallTrust: 'estimated' }],
  ['Planned · Money sent', 'paid', { status: 'planned', settlement: 'upcoming', cashPaymentStatus: 'sent', householdPaymentStatus: 'paid' }],
  ['To confirm · Payment allocation unconfirmed', 'paid', { status: 'unconfirmed', settlement: 'unverified',
    cashPaymentStatus: 'sent', householdPaymentStatus: 'unconfirmed' }],
  ['Paid · Payment allocation unconfirmed (settled)', 'paid', { status: 'PAID', settlement: 'represented',
    cashPaymentStatus: 'sent', householdPaymentStatus: 'unconfirmed' }],
  ['Paid · Money sent', 'paid', { status: 'PAID', settlement: 'represented', cashPaymentStatus: 'sent', householdPaymentStatus: 'paid' }],
  ['Partly paid · Rest unknown', 'paid', { status: 'unconfirmed', settlement: 'unverified', cashPaymentStatus: 'sent',
    householdPaymentStatus: 'partial' }],
  ['To confirm · minimum amount unconfirmed', 'paid', { status: 'unconfirmed', settlement: 'unverified', cashPaymentStatus: 'sent',
    householdPaymentStatus: 'sent' }],
  ['To confirm (due date passed, nothing seen)', 'not-paid', { status: 'still due', settlement: 'unverified', actual: null }],
  ['To confirm · Inside opening balance', 'not-paid', { status: 'planned', settlement: 'opening' }],
  ['Status unavailable (unknown settlement)', 'not-paid', { status: 'still due', settlement: 'unknown' }],
  ['Status unavailable (PAID with an unknown settlement)', 'not-paid', { status: 'PAID', settlement: 'unknown' }],
  ['To confirm (PAID copy whose evidence is not established)', 'not-paid', { status: 'PAID', settlement: 'unverified' }],
  ['Estimated · Trusted on due date (not seen)', 'not-paid', { status: 'PAID', settlement: 'represented',
    settlementBasis: 'schedule-trust-on-due' }],
  ['Paid (a seen payment)', 'paid', { status: 'PAID', settlement: 'represented', actual: 90 }],
  ['Paid · over planned', 'paid', { status: 'PAID', settlement: 'represented', actual: 95, excess: 5, excessTrust: 'calculated' }],
  ['Paid (inside the opening, and seen paid)', 'paid', { status: 'PAID', settlement: 'opening' }],
  ['Needs a date', 'not-paid', { status: 'needs-date', settlement: 'upcoming', needsDate: true, date: null }],
  ['Due', 'not-paid', { status: 'still due', settlement: 'upcoming' }],
  ['Not paid (upcoming, contradictory status)', 'not-paid', { status: 'unconfirmed', settlement: 'upcoming' }],
  ['Status unavailable (no settlement)', 'not-paid', { status: 'still due' }],
];
for (const [name, want, fields] of CASES) {
  const row = { ...base, ...fields };
  ok(F.billPaidState(row) === want, `${name}: ${want}`);
}
ok(F.billPaidState(null) === 'not-paid' && F.billPaidState({}) === 'not-paid', 'no row, or a row with nothing known: Not paid');

console.log('real rows: invented raw Lunch Money -> observer -> Forecast.recommend');
function rowsFor(bill, txs, asOf) {
  const w = H.baseWorld(asOf);
  w.bills = [bill];
  w.transactions = txs;
  const r = H.observe(w);
  if (r.error) throw r.error;
  const rec = F.recommend(r.plan, w.asOf, { currentPeriodActuals: r.packet });
  return { w, r, rec, row: rec.payPeriodViews.flatMap(v => v.bills || []).find(b => b.id === bill.id && b.date === '2026-10-12') };
}
const HYDRO = { id: 'hydro', label: 'Invented hydro', amount: 90, frequency: 'monthly', day: 12, confidence: 'confirmed', payee: 'Invented hydro' };
const pay = (amount, extra = {}) => H.lm({ date: '2026-10-12', amount, category: 'Utilities', account: 'chequing-a', payee: 'Invented hydro', ...extra });
const DUE = '2026-10-12';
const OCCURRENCE_PERIOD = '2026-10-09';
const REAL = [
  { name: 'posted in full', txs: [pay(90)], word: 'paid', evidence: 'posted-equal', checked: true, paid: 90 },
  { name: 'posted in part', txs: [pay(40)], word: 'paid', evidence: 'posted-differs', checked: false, paid: 0 },
  { name: 'a differing posted payment verified on its occurrence', txs: [pay(40, { notes: 'bill verified' })],
    word: 'paid', evidence: 'posted-verified', checked: true, paid: 40, amount: 40 },
  { name: 'one pending debit only', txs: [pay(90, { pending: true })], word: 'paid', evidence: 'pending', checked: false, paid: 0 },
  { name: 'nothing received', txs: [], word: 'not-paid', evidence: 'none', checked: false, paid: 0 },
  { name: 'before the due period', asOf: '2026-10-05', txs: [], word: 'not-paid', evidence: 'none', checked: false, paid: 0 },
];

function assertOccurrences(views, word) {
  let occurrences = 0;
  for (const v of views) {
    for (const bill of v.bills || []) {
      const target = bill.id === HYDRO.id && bill.date === DUE;
      assert.equal(bill.paidState, target ? word : 'not-paid', 'payment evidence belongs to its own occurrence');
      if (target) {
        assert.equal(v.start, OCCURRENCE_PERIOD);
        occurrences++;
      }
    }
  }
  assert.equal(occurrences, 1, 'the target occurrence appears once across the timeline');
}

for (const expected of REAL) {
  test('Bills on Stack: ' + expected.name, async () => {
    const x = rowsFor(HYDRO, expected.txs, expected.asOf);
    assertOccurrences(x.rec.payPeriodViews, expected.word);
    if (expected.asOf) assert.equal(x.row.settlement, 'upcoming');

    H.resetCaptures();
    const { data, error } = H.dataOf(x.w);
    if (error) throw error;
    const page = await loadStackPage({ data });
    assert.equal(page.status(), 'rendered');
    assert.equal(page.selectPeriod(OCCURRENCE_PERIOD), OCCURRENCE_PERIOD);
    assert.deepEqual(page.errors, []);
    const views = page.context().recommendation.payPeriodViews;
    assertOccurrences(views, expected.word);
    const view = views.find(v => v.start === page.selectedKey());
    const bill = view.bills.find(b => b.id === HYDRO.id && b.date === DUE);
    const counted = expected.amount ?? 90;
    assert.deepEqual([bill.stackBillPaymentEvidence, bill.stackBillPaid, bill.stackBillAmount, view.stackSummary.bills.paid],
      [expected.evidence, expected.checked, counted, expected.paid], 'confirmed payment and the amount counted once');
    const card = page.blockHtml('cards').match(/<details[^>]*data-stack-card="bills"[\s\S]*?<\/details>/)?.[0];
    assert.ok(card, 'the selected period draws its Bills card');
    const row = card.match(/<li[^>]*data-stack-sheet="bill:hydro@2026-10-12"[^>]*>[\s\S]*?<\/li>/)?.[0];
    assert.ok(row && row.includes(HYDRO.label), 'the card opens this occurrence');
    const printed = row.match(/class="sc-a[^"]*"[^>]*>([^<]*)<\/span>/);
    assert.equal(printed?.[1], '$' + counted, 'the occurrence prints its counted amount');
    assert.equal(row.includes('aria-label="Paid"'), expected.checked, 'the occurrence has its own Paid check');
    const head = card.slice(0, card.indexOf('</summary>')).replace(/<[^>]*>/g, '');
    assert.ok(head.includes('$' + expected.paid + ' / $' + counted), 'the card prints the confirmed payment total over the bill load');
  });
}

console.log('presentation only: nothing else moves');
{
  const x = rowsFor(HYDRO, [pay(40)]);
  const strip = rec => JSON.parse(JSON.stringify(rec, (k, val) => (k === 'paidState' ? undefined : val)));
  const again = F.recommend(x.r.plan, x.w.asOf, { currentPeriodActuals: x.r.packet });
  ok(JSON.stringify(strip(again)) === JSON.stringify(strip(x.rec)), 'a rerun is identical once the word is removed (deterministic)');
  const views = x.rec.payPeriodViews;
  ok(views.every(v => (v.bills || []).every(b => ['paid', 'not-paid', 'carried'].includes(b.paidState))),
    'every row carries exactly one of paid / not-paid / carried');
  ok(x.row.status === 'PAID' && x.row.actual === 40 && x.row.remaining === 0 && x.row.shortfall === 50,
    'the Partly paid row keeps its status, actual, remaining and shortfall', JSON.stringify({ s: x.row.status, a: x.row.actual }));
}

console.log(failures ? `\n${failures} of ${checks} bill paid-state checks FAILED.` : `\nAll bill paid-state checks passed (${checks}).`);
if (failures) process.exit(1);
