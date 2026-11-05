'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const F = require('../public/forecast');
const { ledger } = require('./fixtures/chronological-savings-data');
const { advance, clone } = require('./fixtures/savings-daily-allocation-contract');
const cardHeldSnapshot = require('./fixtures/annual-snapshot-carry-data');
// PA-4a-2b (Muse #812 6541361235): the shared ledger pays the annual cost on
// a card with an untagged card-payment pair, a HARD card hold. Under C7 a
// hard-held close feeds no numeric dependent opening, so the annual-carry
// assertions run on the same 200 - 100 = 100 ledger paid directly from Bills
// (card-clean). The card-held scene is kept and asserted null separately.
const snapshotFixture = () => {
  const i = cardHeldSnapshot();
  i.plan.bills.find(b => b.id === 'annual').payingAccount = 'chequing-a';
  i.opts.currentPeriodActuals.transactions = [{ id: 'annual-posted', date: '2026-10-10', amount: 100,
    pending: false, currency: 'CAD', atlasAccountId: 'chequing-a', accountRole: 'household-cash', billId: 'annual' }];
  return i;
};

// Independent invented ledger: 80 operating + 119 savings; 60 club due
// October 21, 17.29 annual premium due October 25, 77 receipt November 2.
// The insurance has the same explicit yearly Savings goal as Square One.
function fixture(premium = 17.29) {
  const i = advance(ledger(), '2026-10-10');
  i.plan.income[0].anchor = '2026-08-14';
  i.plan.opening.paydaySnapshot = { periodStart: '2026-10-09', asOf: '2026-10-09', opening: 80 };
  i.plan.opening.representedEvents = [];
  i.opts.currentPeriodActuals.coverageStart = '2026-10-09';
  i.opts.currentPeriodActuals.savingsFetchCoverage.startDate = '2026-10-09';
  i.plan.bills = [{ id: 'annual', label: 'Invented annual premium', amount: premium,
    frequency: 'yearly', month: 10, day: 25, firstDue: '2026-10-25',
    jointCash: false, confidence: 'estimated' }];
  i.plan.savingsEarmarks.pools[1].goalRefs = [{ kind: 'yearly-bill', id: 'annual' }];
  return i;
}
const run = i => F.recommend(i.plan, i.asOf, { ...i.opts, debts: i.debts || [], weeklyVariable: 0 });
const period = (a, start) => a.payPeriodViews.find(p => p.start === start);
const figures = p => [p.incomeTotal, p.periodBillLoad, p.totalBillsThisPeriod,
  p.remainingBills, p.budgetHold, p.afterBills, p.balanceAfterDeductions];
const point = (a, date) => {
  assert.equal(a.savingsFunding.timeline.status, 'ready', a.savingsFunding.timeline.reason);
  return a.savingsFunding.timeline.daily.find(row => row.date === date);
};

test('annual savings cost stays off payday Bills and October current figures stay unchanged', () => {
  const i = fixture(), before = JSON.stringify(i), a = run(i);
  const without = clone(i); without.plan.bills = [];
  assert.deepEqual(figures(period(a, '2026-10-09')), figures(period(run(without), '2026-10-09')));
  const next = period(a, '2026-10-23');
  assert.deepEqual(figures(next), [77, 0, 0, 0, 0, 77, 77],
    '77 receipt minus zero routine bills and zero Household Budget; no second 17.29 deduction');
  assert.ok(!next.bills.some(row => row.id === 'annual'));
  assert.equal(next.predictedEndingBalanceTerms.assignedBills, 0);
  assert.equal(next.predictedEndingBalanceTerms.closes, true);
  assert.equal(JSON.stringify(i), before, 'no input, paid state, date or estimate mutation');
});

test('one dated obligation consumes savings once and conserves household cash', () => {
  const i = fixture(), a = run(i), s = a.savingsFunding;
  const occurrence = F.expandEvents(i.plan, i.asOf, '2026-11-05').filter(e => e.id === 'annual');
  assert.equal(occurrence.length, 1);
  assert.equal(occurrence[0].date, '2026-10-25');
  assert.equal(occurrence[0].amount, -17.29);
  assert.equal(occurrence[0].confidence, 'estimated');
  assert.equal(s.backing.items.find(row => row.id === 'annual').needed, 17.29);
  assert.equal(s.backing.items.find(row => row.id === 'annual').saved, 17.29);
  const payments = s.timeline.payments.filter(row => row.id === 'annual');
  assert.equal(payments.length, 1);
  assert.equal(payments[0].amount, 17.29);
  assert.equal(payments[0].fromCurrentStock, 17.29);
  assert.equal(payments[0].fromProjectedTopups, 0);
  for (const [date, operating, savings, total] of [
    ['2026-10-10', 80, 119, 199],
    ['2026-10-21', 80, 59, 139],
    ['2026-10-25', 80, 41.71, 121.71],
    ['2026-11-02', 157, 41.71, 198.71],
  ]) {
    const row = point(a, date);
    assert.deepEqual([row.operatingCash, row.savingsCash, row.combinedHouseholdCash], [operating, savings, total]);
    assert.equal(Math.round(row.operatingCash * 100) + Math.round(row.savingsCash * 100), Math.round(total * 100));
  }
  assert.equal(period(a, '2026-10-23').plannedCostFunding.billPaymentsAlreadyDeducted, 0);
  assert.equal(period(a, '2026-10-23').plannedCostFunding.proposedFundingForBillPayments, 0);
});

test('unfunded premium is still a real dated shortage, never erased or financed by later income', () => {
  const i = fixture(200), a = run(i);
  const row = a.savingsFunding.backing.items.find(row => row.id === 'annual');
  assert.equal(row.needed, 200);
  assert.equal(row.saved, 59, '119 stock less earlier 60 club cost');
  const e = F.expandEvents(i.plan, i.asOf, '2026-11-05', i.opts).find(e => e.id === 'annual');
  assert.equal(e.amount, -200);
  assert.equal(e.reserveFunding.amount, 59);
  const sim = F.simulate(i.plan, i.asOf, { ...i.opts, weeklyVariable: 0 });
  assert.equal(sim.daily.find(row => row.date === '2026-10-25').balance, -61,
    '80 operating less 141 unfunded premium; November receipt cannot fund October');
  assert.equal(a.savingsFunding.schedule.status, 'funding-gap');
  assert.equal(a.savingsFunding.actionPermission, 'not-granted');
  const unconfirmed = F.expandEvents(i.plan, i.asOf, '2026-11-05').find(e => e.id === 'annual');
  assert.equal(unconfirmed.reserveFunding, undefined, 'missing movement evidence cannot seed a Savings payment');
  assert.equal(unconfirmed.amount, -200, 'the real obligation remains without backing evidence');
});

test('missing savings or unknown premium retains requirement and fails funding closed', () => {
  for (const kind of ['stock', 'premium']) {
    const i = fixture();
    if (kind === 'stock') i.plan.savingsPoolObservation.accounts.pop();
    else delete i.plan.bills[0].amount;
    const a = run(i), s = a.savingsFunding;
    assert.equal(s.backing.status, 'unavailable');
    assert.equal(s.period.proposal, null);
    assert.equal(s.timeline.status, 'unavailable');
    const annual = [...s.backing.items, ...s.unresolved].find(row => row.id === 'annual');
    assert.ok(annual, 'obligation remains named');
    assert.equal(annual.needed, kind === 'stock' ? 17.29 : null);
    assert.equal(annual.saved, null);
  }
});

test('ordinary card bills and yearly joint-cash bills retain their existing paycheck deductions', () => {
  const i = fixture();
  i.plan.bills.push(
    { id: 'monthly-card', label: 'Invented monthly card bill', amount: 11.13, frequency: 'monthly',
      day: 24, jointCash: false, confidence: 'estimated' },
    { id: 'annual-cash', label: 'Invented annual cash bill', amount: 23.17, frequency: 'yearly',
      month: 10, day: 26, confidence: 'confirmed' });
  const next = period(run(i), '2026-10-23');
  assert.deepEqual(next.bills.map(row => row.id), ['monthly-card', 'annual-cash']);
  assert.equal(next.periodBillLoad, 34.30);
  assert.equal(next.balanceAfterDeductions, 42.70);
});

test('undated annual cost remains an unknown savings requirement without a payday bill', () => {
  const i = fixture(); i.plan.bills[0].needsDate = true;
  const a = run(i), s = a.savingsFunding;
  assert.equal(s.status, 'unavailable');
  assert.ok(s.unresolved.some(row => row.id === 'annual' && row.date === null && row.needed === 17.29));
  assert.ok(!a.defaultView.undatedBills.some(row => row.id === 'annual'));
  assert.ok(!F.expandEvents(i.plan, i.asOf, '2026-11-05').some(row => row.id === 'annual'));
});

test('routine remainder cannot release an unfunded or unknown annual premium into debt or purchases', () => {
  const i = fixture(200);
  i.plan.nextDollar = { policy: 'true-surplus-highest-interest', provenance: 'owner-stated' };
  i.debts = [{ id: 'card', label: 'Invented card', structure: 'Revolving credit', balance: 500,
    rate: 20, pending: 0, limit: 1000, secured: false, confidence: 'verified' }];
  i.plan.commitments.push({ id: 'purchase', label: 'Invented later purchase', amount: 100,
    date: '2026-12-01', confidence: 'estimated', adjustable: false });
  const next = period(run(i), '2026-10-23');
  assert.equal(next.balanceAfterDeductions, 77, 'routine income less Bills and Household Budget stays 77');
  assert.equal(next.extraDebt.allocated, 0, '141 unbacked premium is protected before the 20 floor');
  assert.ok(next.bigPurchases.length > 0, 'purchase allocation path is exercised');
  assert.equal(next.bigPurchases.reduce((sum, row) => sum + row.allocation, 0), 0,
    'unfunded premium cannot become purchase capacity after debt protection');
  assert.equal(next.afterBigPurchases, 77);
  const before = period(run(i), '2026-11-06');
  assert.ok(before.opening == null || before.opening < 80,
    'internal carry cannot restore the 141 unfunded expense');
  delete i.plan.bills[0].amount;
  assert.equal(period(run(i), '2026-10-23').extraDebt.allocated, null, 'unknown amount grants no new debt instruction');
  i.plan.bills[0].amount = 200; i.plan.bills[0].needsDate = true;
  assert.equal(period(run(i), '2026-10-23').extraDebt.allocated, null, 'unknown timing grants no new debt instruction');
});


test('known zero savings leaves the full annual expense and its dated shortfall intact', () => {
  const i = fixture(200);
  for (const account of i.plan.savingsPoolObservation.accounts) {
    account.value = 0;
    for (const row of [...i.plan.startingCash.breakdown, ...i.plan.startingCash.heldElsewhere]) {
      if (row.id === account.accountId) row.value = 0;
    }
  }
  const a = run(i), s = a.savingsFunding;
  assert.equal(s.stock.status, 'ready');
  assert.equal(s.stock.amount, 0, 'two evidenced zero balances, not missing observations');
  assert.equal(s.backing.items.find(row => row.id === 'annual').saved, 0);
  const expense = F.expandEvents(i.plan, i.asOf, '2026-11-05').find(e => e.id === 'annual');
  assert.equal(expense.amount, -200);
  assert.ok(!expense.reserveFunding || expense.reserveFunding.amount === 0);
  const sim = F.simulate(i.plan, i.asOf, { ...i.opts, weeklyVariable: 0 });
  assert.equal(sim.daily.find(row => row.date === '2026-10-21').balance, 20, '80 less 60 club cost');
  assert.equal(sim.daily.find(row => row.date === '2026-10-25').balance, -180, '20 less full 200 premium');
  assert.equal(sim.daily.find(row => row.date === '2026-11-02').balance, -103, 'later 77 cannot repair the earlier deadline');
  assert.equal(s.schedule.status, 'funding-gap');
  assert.equal(s.moneyMovementPermission, 'not-granted');
});

function markedSnapshot(base = snapshotFixture) {
  const i = base();
  // Classification only: existing purpose-reserve schema, no stock or
  // historical funding invented. Missing evidence still withholds proposals.
  i.plan.savingsEarmarks = { version: 1, currency: 'CAD', history: [], pools: [
    { id: 'home', accountId: 'savings', role: 'purpose-reserve', purpose: 'Invented annual cost',
      goalRefs: [{ kind: 'yearly-bill', id: 'annual' }] },
    { id: 'spare', accountId: 'savings-spare' },
  ] };
  return i;
}

test('represented annual payment after the original payday snapshot cannot inflate future carry', () => {
  for (const i of [snapshotFixture(), markedSnapshot()]) {
    const original = JSON.stringify(i), a = run(i);
    const native = F.simulate(i.plan, i.asOf, i.opts);
    for (const [date, expected] of [['2026-10-23', 200 - 100], ['2026-11-06', 200 - 100 + 77]]) {
      const row = period(a, date);
      // S1 supersession: the native carry is unchanged — snapshot minus
      // the paid cost plus subsequent receipts — and the assertion below
      // still pins it. The Budget OPENING at 2026-11-06, however, now
      // consumes the prior period's published payday sweep: the full 177
      // remainder sweeps on that payday, so the period opens at 0 (was
      // 177, when the opening passed the carry through untouched). The
      // represented payment still cannot inflate anything: the sweep
      // pinned after this loop is exactly the uninflated 177, not 277.
      assert.equal(row.opening, date === '2026-11-06' ? 0 : expected,
        `${date}: snapshot minus paid cost plus subsequent receipts, less any sweep that landed on that payday`);
      assert.equal(native.daily.find(r => r.date === date).balance, expected);
      // Proposals stay withheld for the marked scene (missing evidence) and
      // in every card-held scene (asserted below); the card-clean plain scene
      // is the one whose only withholding cause was the card hold.
      if (i.plan.savingsEarmarks) assert.equal(row.plannedCostFunding.status, 'unavailable');
      assert.equal(row.extraDebt.status, 'unavailable');
    }
    assert.equal(period(a, '2026-10-23').paydaySweep, 200 - 100 + 77,
      'the published sweep is the uninflated remainder: snapshot minus paid cost plus subsequent receipts');
    const marked = !!i.plan.savingsEarmarks;
    assert.equal(period(a, '2026-10-09').periodBillLoad, marked ? 0 : 100);
    assert.equal(period(a, '2026-10-23').openingSource, marked ? 'cutover-walk' : 'carry-forward');
    assert.equal(F.expandEvents(i.plan, i.asOf, '2026-11-19').filter(e => e.id === 'annual').length, 0,
      'represented expense must not be replayed after the observed opening');
    assert.equal(JSON.stringify(i), original);
  }
  // The original card-held ledger (hard hold: untagged card-payment pair).
  // C7: its withheld close feeds no numeric dependent opening or sweep, while
  // the native walk, proposal withholding and no-replay facts are unchanged.
  for (const i of [cardHeldSnapshot(), markedSnapshot(cardHeldSnapshot)]) {
    const original = JSON.stringify(i), a = run(i);
    const native = F.simulate(i.plan, i.asOf, i.opts);
    assert.equal(a.cardPurchaseCoverage.status, 'unavailable');
    for (const [date, expected] of [['2026-10-23', 200 - 100], ['2026-11-06', 200 - 100 + 77]]) {
      const row = period(a, date);
      assert.equal(row.opening, null, `${date}: a hard-held close carries no numeric opening`);
      assert.equal(row.paydaySweep, null, `${date}: and no numeric sweep`);
      assert.equal(native.daily.find(r => r.date === date).balance, expected);
      assert.equal(row.plannedCostFunding.status, 'unavailable');
      assert.equal(row.extraDebt.status, 'unavailable');
    }
    assert.equal(F.expandEvents(i.plan, i.asOf, '2026-11-19').filter(e => e.id === 'annual').length, 0);
    assert.equal(JSON.stringify(i), original);
  }
});

test('same-day represented payment qualifies snapshot carry; already-paid opening is not charged again', () => {
  const i = markedSnapshot();
  i.asOf = i.plan.opening.asOf = '2026-10-10';
  i.opts.currentPeriodActuals.observationAsOf = i.opts.currentPeriodActuals.coverageThrough = i.asOf;
  if (i.opts.currentPeriodActuals.savingsFetchCoverage) i.opts.currentPeriodActuals.savingsFetchCoverage.endDate = i.asOf;
  assert.equal(period(run(i), '2026-10-23').opening, 100);
  const included = markedSnapshot();
  included.plan.opening.paydaySnapshot = { periodStart: '2026-10-09', asOf: '2026-10-11', opening: 100 };
  assert.equal(period(run(included), '2026-10-23').opening, 100, '100 opening already includes the expense');
  const unavailable = markedSnapshot();
  unavailable.opts.operatingPlan = 'unavailable';
  assert.equal(period(run(unavailable), '2026-10-23').opening, null);
  assert.equal(period(run(unavailable), '2026-10-23').plannedCostFunding.contribution, null);
});

test('Travel Visa yearly fee without a Savings goal retains its owner-directed Bills deduction', () => {
  const i = fixture();
  i.asOf = i.plan.opening.asOf = '2027-10-01';
  // The observation window moves with the as-of date. A 2026 packet beside a 2027 plan is stale
  // coverage, which the coverage gate rightly withholds the dependent remainder for.
  const observed = i.opts.currentPeriodActuals;
  observed.coverageStart = '2027-09-24';
  observed.observationAsOf = observed.coverageThrough = i.asOf;
  if (observed.savingsFetchCoverage) observed.savingsFetchCoverage.endDate = i.asOf;
  i.plan.opening.paydaySnapshot = { periodStart: '2027-09-24', asOf: '2027-09-24', opening: 100 };
  i.plan.income = [i.plan.income[0]]; i.plan.commitments = [];
  i.plan.bills = [{ id: 'travelvisa-annual-fee-2027', label: 'Travel Visa annual fee',
    frequency: 'yearly', month: 10, day: 6, firstDue: '2027-10-06', amount: 149,
    confidence: 'estimated', dateConfidence: 'estimated', budgetCategory: null,
    jointCash: false, payingAccount: 'travelvisa' }];
  // A Savings assignment to another requirement is not permission to classify this fee.
  i.plan.savingsEarmarks.pools[1].goalRefs = [];
  const a = run(i), row = period(a, '2027-09-24');
  assert.deepEqual([row.incomeTotal, row.periodBillLoad, row.budgetHold, row.balanceAfterDeductions], [0, 149, 0, -149]);
  assert.equal(row.bills.filter(b => b.id === 'travelvisa-annual-fee-2027').length, 1);
  const events = F.expandEvents(i.plan, i.asOf, '2027-10-07').filter(e => e.id === 'travelvisa-annual-fee-2027');
  assert.equal(events.length, 1); assert.equal(events[0].date, '2027-10-06');
  assert.equal(events[0].amount, -149); assert.equal(events[0].confidence, 'estimated');
});

test('40 current backing plus 60 proposed top-up funds exactly one 100 annual draw', () => {
  const i = fixture(100); i.plan.commitments = [];
  i.plan.savingsPoolObservation.accounts[1].value = i.plan.startingCash.heldElsewhere[0].value = 10;
  i.plan.income[1].date = '2026-10-23'; i.plan.income[1].amount = 60;
  const a = run(i), s = a.savingsFunding;
  assert.equal(s.backing.items.find(r => r.id === 'annual').saved, 40);
  const payment = s.timeline.payments.filter(r => r.id === 'annual');
  assert.equal(payment.length, 1);
  assert.deepEqual([payment[0].amount, payment[0].fromCurrentStock, payment[0].fromProjectedTopups], [100, 40, 60]);
  assert.deepEqual([point(a, '2026-10-25').operatingCash, point(a, '2026-10-25').savingsCash,
    point(a, '2026-10-25').combinedHouseholdCash], [80, 0, 80]);
  assert.equal(point(a, '2026-10-10').combinedHouseholdCash + 60 - 100, 80);
  const next = period(a, '2026-10-23');
  assert.equal(next.periodBillLoad, 0);
  assert.equal(next.plannedCostFunding.billPaymentsAlreadyDeducted, 0);
  assert.equal(next.plannedCostFunding.proposedFundingForBillPayments, 0);
  assert.equal(s.moneyMovementPermission, 'not-granted');
});
