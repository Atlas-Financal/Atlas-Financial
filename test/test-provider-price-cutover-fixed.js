'use strict';

// Run directly with node test/test-provider-price-cutover-fixed.js. The acceptance
// harness builds the observation, recurring review, account map and plan in memory.
const assert = require('node:assert/strict');
const test = require('node:test');
const H = require('./acceptance/harness');
const Live = require('../scripts/live-plan');
const Observer = require('../scripts/provider-observe');

const AS_OF = '2026-10-14';
const ITEM_ID = '7123461';
const JUNE = '2026-06-01';
const payments = ['2026-06-05', '2026-07-05', '2026-08-05', '2026-09-05', '2026-10-05'];

function observationInput(dates, { from = JUNE, amounts = [], complete = true, id = 'studio', day = 5,
  asOf = AS_OF, historyStart = '2026-03-28' } = {}) {
  const w = H.baseWorld(asOf);
  const payee = 'Invented ' + id;
  const dayOfMonth = String(day).padStart(2, '0');
  const firstDue = '2026-01-' + dayOfMonth;
  w.bills = [{ id, label: payee, payee, frequency: 'monthly', day, firstDue, amount: 70, confidence: 'estimated', payingAccount: 'chequing-a',
    ...(from ? { rule: { lunchMoneyRecurringIds: [ITEM_ID], linkedFrom: from } } : {}) }];
  w.amountHistory = { startDate: historyStart, coverage: { complete }, transactions: dates.map((date, i) =>
    H.lm({ date, payee, account: 'chequing-a', amount: amounts[i] ?? (from ? 93 : 70) })) };
  H.productionOpening(w);
  const data = H.canonicalOf(w, H.planOf(w));
  const payload = H.rawPayload(w);
  if (from) {
    payload.recurringItems = { status: 'read', read: { unexpectedPaginationEvidence: false,
      requestedWindow: { startDate: w.windowStart, endDate: asOf },
      items: [{ providerId: ITEM_ID, status: 'reviewed', unavailableFields: [],
        criteria: { startDate: firstDue, endDate: null, granularity: 'month', quantity: 1,
          anchorDate: asOf.slice(0, 8) + dayOfMonth, amount: '93.0000', currency: 'CAD',
          plaidAccountId: '9001', manualAccountId: null },
        matches: { expectedOccurrenceDates: [], foundTransactions: [] } }] } };
  }
  return { data, payload, accountMap: H.accountMapOf(w), identity: H.identityOf(w) };
}

function check(label, dates, options) {
  test(label, () => {
    const { id = 'studio', from = JUNE, complete = true, fixed } = options;
    const input = observationInput(dates, options);
    const result = Live.fromObservation(input);
    assert.ifError(result.error);
    const bill = result.data.plan.bills.find(b => b.id === id);
    const report = result.report.derivedAmountFixed;
    assert.equal(input.data.plan.bills[0].amount, 70, 'original plan price');
    assert.equal(bill.confidence, 'estimated', 'amount confidence');
    assert.equal(bill.amount, from ? 93 : 70, 'served price');
    assert.deepEqual(bill.providerPriceCutover, from ? { from, amountBefore: 70 } : undefined, 'served cutover');
    assert.equal(report.status, complete ? 'complete' : 'unavailable', 'history status');
    assert.deepEqual({ billIds: report.billIds, amountFixed: bill.amountFixed },
      { billIds: fixed ? [id] : [], amountFixed: fixed ? true : undefined });
  });
}

check('June–September completed at provider price, October is current', payments, { fixed: true });
check('one completed payment before June at the same provider price', ['2026-05-05', ...payments], { fixed: false });
const firstOfMonth = [JUNE, '2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01'];
check('an occurrence due on the cutover date is eligible', firstOfMonth, { day: 1, fixed: true });
check('a May 31 posting for the June 1 occurrence uses the new price',
  ['2026-05-31', ...firstOfMonth.slice(1)], { day: 1, fixed: true });
check('May 30 gym payment posted on June 1 still belongs to the old price',
  ['2026-06-01', '2026-06-30', '2026-07-30', '2026-08-30'],
  { id: 'gym', day: 30, asOf: '2026-09-05', historyStart: '2026-02-17', fixed: false });
check('a June 20 payment equidistant from June 5 and July 5 cannot establish a fixed price',
  ['2026-06-20', ...payments.slice(1)], { fixed: false });
check('prior price outside latest six completed payments', ['2026-03-30', '2026-04-05', '2026-05-05', ...payments],
  { from: '2026-04-01', amounts: [70], fixed: true });
check('complete but empty history', [], { fixed: false });
check('incomplete history with otherwise qualifying payments', payments, { complete: false, fixed: false });
check('October cannot supply the third completed payment', payments.slice(-3), { fixed: false });
check('completed payments at the old price', payments, { amounts: [70, 70, 70, 70, 70], fixed: false });
check('plain bill at its plan price', payments, { from: null, fixed: true });
check('plain bill at another price', payments, { from: null, amounts: [93, 93, 93, 93, 93], fixed: false });

test('a cutover without its earlier price stays withheld', () => {
  const input = observationInput(payments);
  const result = Live.fromObservation(input);
  assert.ifError(result.error);
  const plan = result.data.plan;
  const opts = { plan, accountMap: input.accountMap, identityRules: input.identity.rules,
    categories: input.payload.categories, tags: input.payload.tags, fetchedAt: input.payload.fetchedAt };
  const derive = () => Observer.derivedAmountFixedBills(input.payload.amountHistory, opts);
  assert.deepEqual(derive().billIds, ['studio'], 'the otherwise identical complete cutover qualifies');
  delete plan.bills[0].providerPriceCutover.amountBefore;
  const malformed = derive();
  assert.equal(malformed.status, 'complete');
  assert.deepEqual(malformed.billIds, []);
});
