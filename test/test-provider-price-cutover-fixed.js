'use strict';

// Run directly with node test/test-provider-price-cutover-fixed.js. The acceptance
// harness builds the observation, recurring review, account map and plan in memory.
const assert = require('node:assert/strict');
const test = require('node:test');
const H = require('./acceptance/harness');
const Live = require('../scripts/live-plan');

const AS_OF = '2026-10-14';
const PAYEE = 'Invented studio';
const ITEM_ID = '7123461';
const JUNE = '2026-06-01';
const payments = ['2026-06-05', '2026-07-05', '2026-08-05', '2026-09-05', '2026-10-05'];

function observe(dates, { from = JUNE, amounts = [], complete = true }) {
  const w = H.baseWorld(AS_OF);
  w.bills = [{ id: 'studio', label: PAYEE, payee: PAYEE, frequency: 'monthly', day: 5,
    firstDue: '2026-01-05', amount: 70, confidence: 'estimated', payingAccount: 'chequing-a',
    ...(from ? { rule: { lunchMoneyRecurringIds: [ITEM_ID], linkedFrom: from } } : {}) }];
  w.amountHistory = { startDate: '2026-03-28', coverage: { complete }, transactions: dates.map((date, i) =>
    H.lm({ date, payee: PAYEE, account: 'chequing-a', amount: amounts[i] ?? (from ? 93 : 70) })) };
  H.productionOpening(w);
  const data = H.canonicalOf(w, H.planOf(w));
  const payload = H.rawPayload(w);
  if (from) {
    payload.recurringItems = { status: 'read', read: { unexpectedPaginationEvidence: false,
      requestedWindow: { startDate: '2026-09-30', endDate: AS_OF },
      items: [{ providerId: ITEM_ID, status: 'reviewed', unavailableFields: [],
        criteria: { startDate: '2026-01-05', endDate: null, granularity: 'month', quantity: 1,
          anchorDate: '2026-10-05', amount: '93.0000', currency: 'CAD',
          plaidAccountId: '9001', manualAccountId: null },
        matches: { expectedOccurrenceDates: [], foundTransactions: [] } }] } };
  }
  const result = Live.fromObservation({ data, payload, accountMap: H.accountMapOf(w), identity: H.identityOf(w) });
  assert.ifError(result.error);
  const bill = result.data.plan.bills.find(b => b.id === 'studio');
  const report = result.report.derivedAmountFixed;
  return { originalPrice: data.plan.bills[0].amount, bill, report };
}

function check(label, dates, options) {
  test(label, () => {
    const { from = JUNE, complete = true, fixed } = options;
    const { originalPrice, bill, report } = observe(dates, options);
    assert.equal(originalPrice, 70, 'original plan price');
    assert.equal(bill.confidence, 'estimated', 'amount confidence');
    assert.equal(bill.amount, from ? 93 : 70, 'served price');
    assert.deepEqual(bill.providerPriceCutover, from ? { from, amountBefore: 70 } : undefined, 'served cutover');
    assert.equal(report.status, complete ? 'complete' : 'unavailable', 'history status');
    assert.deepEqual({ billIds: report.billIds, amountFixed: bill.amountFixed },
      { billIds: fixed ? ['studio'] : [], amountFixed: fixed ? true : undefined });
  });
}

check('June–September completed at provider price, October is current', payments, { fixed: true });
check('one completed payment before June at the same provider price', ['2026-05-05', ...payments], { fixed: false });
check('payment on the cutover date is eligible', [JUNE, ...payments.slice(1)], { fixed: true });
check('prior price outside latest six completed payments', ['2026-03-30', '2026-04-05', '2026-05-05', ...payments],
  { from: '2026-04-01', amounts: [70], fixed: true });
check('complete but empty history', [], { fixed: false });
check('incomplete history with otherwise qualifying payments', payments, { complete: false, fixed: false });
check('October cannot supply the third completed payment', payments.slice(-3), { fixed: false });
check('completed payments at the old price', payments, { amounts: [70, 70, 70, 70, 70], fixed: false });
check('plain bill at its plan price', payments, { from: null, fixed: true });
check('plain bill at another price', payments, { from: null, amounts: [93, 93, 93, 93, 93], fixed: false });
