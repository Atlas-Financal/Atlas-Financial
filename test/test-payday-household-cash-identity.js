'use strict';
// Independent cash ledger for the PR #262 follow-up. Expected dollars are
// hand-worked literals, never obtained from another Forecast calculation.
const assert = require('assert/strict');
const F = require('../public/forecast.js');
const O = require('../scripts/provider-observe.js');
const START = '2026-08-28';
const AS_OF = '2026-09-04';

function plan(cash = 5000, mixed = false) {
  return {
    windowDays: 14, defaults: { targetBuffer: 0 },
    startingCash: { amount: cash },
    opening: {
      asOf: AS_OF, priorAsOf: START, representedEvents: [],
      paydaySnapshot: { periodStart: START, asOf: START, opening: 3000 },
    },
    income: [{ id: 'payroll', label: 'Seaspan', frequency: 'biweekly',
      anchor: START, amount: 2000, confidence: 'confirmed' }],
    obligations: [], bills: [], commitments: [],
    budget: { categories: [
      { id: 'groceries', label: 'Groceries', class: 'essential',
        from: ['Groceries'], plannedWeekly: 450 },
      ...(mixed ? [
        { id: 'fuel', label: 'Fuel', class: 'essential',
          from: ['Fuel'], plannedPayday: 325 },
        { id: 'restaurants', label: 'Eating out', class: 'discretionary',
          from: ['Restaurants'], plannedPayday: 200 },
      ] : []),
    ] },
  };
}
function tx(amount, extra = {}) {
  return { id: 'grocery', coverageRef: 'grocery', currency: 'cad', date: '2026-09-01', amount, pending: false,
    categoryLabel: 'Groceries', confirmedGrocery: true,
    accountRole: 'household-cash', atlasAccountId: 'chequing-a', ...extra };
}
function packet(transactions, extra = {}) {
  return { schema: 'atlas-current-period-actuals/v1', observationAsOf: AS_OF,
    coverageStart: START, coverageThrough: AS_OF, pendingCoverage: 'complete',
    transactionCoverage: 'complete', transactions, ...extra };
}
function options(transactions, extra = {}) {
  return { debts: [], targetBuffer: 0, weeklyVariable: 0,
    currentPeriodActuals: packet(transactions), ...extra };
}

// B102 is the same cash-identity defect for every spending category.
// Merchant $250 + future groceries $900 leaves $3,850, before or after posting.
for (const [name, category] of [
  ['Other Spending', null],
  ['discretionary', { id: 'dining', label: 'Dining', class: 'discretionary', from: ['Dining'], plannedPayday: 200 }],
  ['zero-target essential', { id: 'supplies', label: 'Supplies', class: 'essential', from: ['Supplies'], plannedPayday: 0 }],
]) {
  for (const destination of ['debt', 'optional', 'unallocated', 'mixed']) {
    for (const settled of [false, true]) {
      const p = plan(settled ? 4750 : 5000);
      if (category) p.budget.categories.push(category);
      p.nextDollar = { policy: 'true-surplus-highest-interest', provenance: 'owner-stated' };
      if (destination === 'optional' || destination === 'mixed') {
        p.commitments.push({ id: 'optional', label: 'Optional purchase', flexibility: 'optional',
          amount: destination === 'mixed' ? 1000 : 10000, date: '2026-10-01' });
      }
      const debts = destination === 'debt' || destination === 'mixed'
        ? [{ id: 'debt', label: 'Debt', structure: 'Revolving', rate: 20,
          balance: destination === 'mixed' ? 1000 : 10000, pending: 0, limit: 20000 }] : [];
      const spending = tx(250, { id: 'b102', pending: !settled, confirmedGrocery: false,
        categoryLabel: category ? category.label : 'Gifts' });
      const classification = F.classifyCurrentPeriodTransaction(spending, p, options([spending]));
      assert.equal(classification.categoryId, category ? category.id : 'uncategorised', name + ': incumbent category');
      const a = F.paydayAllocation(p, AS_OF, options([spending], { debts }));
      const optional = a.optional.reduce((sum, row) => sum + row.allocated, 0);
      assert.equal(a.extraDebt.allocated, destination === 'debt' ? 3850 : destination === 'mixed' ? 1000 : 0,
        name + ': no pending principal released to debt');
      assert.equal(optional, destination === 'optional' ? 3850 : destination === 'mixed' ? 1000 : 0,
        name + ': no pending principal released to optional');
      assert.equal(a.unallocated, destination === 'unallocated' ? 3850 : destination === 'mixed' ? 1850 : 0);
      assert.equal(a.extraDebt.allocated + optional + a.unallocated, 3850, name + ': releasable total');
      assert.equal(a.essentials.wanted, 900, name + ': no category promotion');
      assert.deepEqual(a.essentials.items.map(row => row.id), ['groceries'], name + ': no invented target');
      assert.equal(a.protectedPath.allocated, settled ? 0 : 250, name + ': pending encumbered once');
      assert.equal(a.identity, settled ? 4750 : 5000, name + ': posted cash conservation');
      assert.equal(a.lines.reduce((sum, row) => sum + row.amount, 0) + a.unallocated,
        settled ? 4750 : 5000, name + ': independent allocation sum');
    }
  }
}
function check(name, cash, transactions, hold, calendarLeft, mixed = false, pendingHold = 0) {
  const p = plan(cash, mixed);
  const opts = options(transactions);
  const a = F.paydayAllocation(p, AS_OF, opts);
  assert.equal(a.available, cash, name + ': posted cash is not replayed');
  assert.equal(a.essentials.wanted, hold, name + ': essential cash requirement');
  assert.equal(a.essentials.allocated, hold, name + ': funded requirement');
  assert.equal(a.protectedPath.allocated, pendingHold, name + ': unsettled cash principal');
  assert.equal(a.unallocated, calendarLeft, name + ': independently reconciled releasable cash');
  assert.equal(a.identity, cash, name + ': allocation conservation');
  const rec = F.recommend(p, AS_OF, opts);
  assert.equal(rec.paydayAllocation.essentials.wanted, hold, name + ': recommend integration');
  const period = rec.defaultView.calendarPeriods.find(r => r.id === 'this-pay-period');
  assert.equal(period.available, 2000, name + ': Payday balance is period income');
  assert.equal(period.afterHouseholdBudget,
    2000 - (Number(period.periodBillLoad) || 0) - period.budgetHold,
    name + ': Balance After Deductions is income minus bills minus Household Budget hold');
  assert.notEqual(period.afterHouseholdBudget, 3000 + 2000 - period.budgetHold,
    name + ': Balance After Deductions does not add the frozen payday-snapshot opening');
  console.log('PASS ' + name);
  return a;
}

// Frozen resources $5,000. Settled cash purchases reduce current cash.
// No purchase: 5000 - 900 = 4100. Under plan: 4400 - 300 = 4100.
// At plan: 4100 - 0 = 4100. Over plan: 4000 - 0 = 4000.
check('no actuals yet', 5000, [], 900, 4100);
const under = check('600 settled, under 900 plan', 4400, [tx(600)], 300, 4100);
check('900 settled, exactly at plan', 4100, [tx(900)], 0, 4100);
const over = check('1000 settled, 100 overspend', 4000, [tx(1000)], 0, 4000);
assert.equal(over.essentials.items[0].remaining, -100);
// Reapplying max(plan, actual) to CURRENT cash counts settled cash twice.
assert.equal(4400 - under.essentials.wanted, 4100);
assert.notEqual(4400 - 900, 4100);

const other = tx(250, { id: 'other', confirmedGrocery: false, categoryLabel: 'Gifts' });
check('Other Spending already left current cash', 4750, [other], 900, 3850);
// Cash: 5000 - 1000 groceries - 200 fuel - 250 dining - 100 Other = 3450.
// Essential future need: 0 groceries + 125 fuel. Dining is discretionary.
// Calendar load: 1000 + 325 + 250 + 100 = 1675; leftover 3325.
check('planned essentials, discretionary category, and Other', 3450, [
  tx(1000),
  tx(200, { id: 'fuel', confirmedGrocery: false, categoryLabel: 'Fuel', confirmedFuel: true }),
  tx(250, { id: 'dining', confirmedGrocery: false, categoryLabel: 'Restaurants' }),
  { ...other, amount: 100 },
], 125, 3325, true);

const pending = tx(600, { pending: true, pendingTreatment: 'unresolved' });
check('positive essential plus Other pending cash', 5000,
  [pending, { ...other, pending: true }], 300, 3850, false, 850);
// Cash has NOT left: 5000 - (600 awaiting debit + 300 future groceries) = 4100.
check('pending cash must remain reserved', 5000, [pending], 300, 4100, false, 600);
check('pending cash over plan must remain reserved', 5000, [{ ...pending, amount: 1000 }], 0, 4000, false, 1000);
check('400 posted plus 600 pending cash', 4600, [
  tx(400), { ...pending, id: 'pending-second' },
], 0, 4000, false, 600);
check('same purchase after cash settlement', 4400, [tx(600)], 300, 4100);

// Card purchases consume grocery capacity but do not debit chequing.
// Pending -> posted leaves $600 debt exposure and $300 future grocery need.
for (const state of ['pending', 'posted']) {
  const card = { id: 'card', label: 'Card', structure: 'Revolving',
    rate: 20, balance: state === 'posted' ? 600 : 0,
    pending: state === 'pending' ? 600 : 0, limit: 2000 };
  const p = plan(); p.startingCash.breakdown = [{ id: 'chequing-a', value: 5000 }];
  p.cardPurchaseCoverage = require('./fixtures/card-coverage-opening')(START);
  const a = F.paydayAllocation(p, AS_OF, options([
    tx(600, { accountRole: 'revolving-credit', atlasAccountId: 'card',
      pending: state === 'pending', pendingTreatment: state === 'pending' ? 'unresolved' : 'confirmed-settled' }),
  ], { debts: [card] }));
  assert.equal(a.available, 5000);
  assert.equal(a.essentials.wanted, 300);
  assert.equal(a.protectedPath.allocated, 600, 'uncovered card principal protects Bills cash once');
  assert.equal(a.extraDebt.allocated + a.unallocated, 5000 - 300 - 600);
  assert.equal(card.balance + card.pending, 600);
  assert.equal(F.utilisation([card]).rows[0].used, 600);
}
const cardOtherPlan = plan();
cardOtherPlan.startingCash.breakdown = [{ id: 'chequing-a', value: 5000 }];
cardOtherPlan.cardPurchaseCoverage = require('./fixtures/card-coverage-opening')(START);
const cardOther = F.paydayAllocation(cardOtherPlan, AS_OF, options([
  { ...other, pending: true, accountRole: 'revolving-credit', atlasAccountId: 'card' },
], { debts: [{ id: 'card', structure: 'Revolving', balance: 0, pending: 250, rate: 20, limit: 2000 }] }));
assert.equal(cardOther.protectedPath.allocated, 250, '$250 uncovered card Other protects cash, without replaying principal');
assert.equal(cardOther.essentials.wanted, 900);
assert.equal(cardOther.extraDebt.allocated + cardOther.unallocated, 5000 - 900 - 250);

// Same master-path floor must hold after pending settlement. $5,000 - $250
// leaves $4,750; retaining the existing $4,500 floor allows only $250 out.
// The $900 essentials and pending are inside the total protection, not a
// second $4,500 subtraction. This exercises the binding master probe.
for (const settled of [false, true]) {
  const a = F.paydayAllocation(plan(settled ? 4750 : 5000), AS_OF, options([
    { ...other, pending: !settled },
  ], { targetBuffer: 4500 }));
  assert.equal(a.unallocated, 250, 'pending and settled satisfy the same master cash floor');
  assert.equal(a.protectedPath.allocated, settled ? 3600 : 3850);
  assert.equal(a.identity, settled ? 4750 : 5000);
}

// A dated future requirement competes for the same current cash. By Sept 12:
// 5000 - 250 pending + 2000 payroll - 6000 required cost leaves $750.
for (const settled of [false, true]) {
  const p = plan(settled ? 4750 : 5000);
  p.commitments.push({ id: 'required', label: 'Required future cost',
    date: '2026-09-12', amount: 6000, flexibility: 'required', confidence: 'confirmed' });
  const a = F.paydayAllocation(p, AS_OF, options([{ ...other, pending: !settled }]));
  assert.equal(a.unallocated, 750, 'dated future protection cannot reuse pending principal');
  assert.equal(a.identity, settled ? 4750 : 5000);
}

// Observed pending cannot become surplus at a period boundary or merely
// because coverage no longer earns precise category remaining.
const prior = F.paydayAllocation(plan(), AS_OF, options([
  { ...other, pending: true, date: '2026-08-27' },
]));
assert.equal(prior.essentials.wanted, 900);
assert.equal(prior.protectedPath.allocated, 250);
assert.equal(prior.unallocated, 3850);
const incomplete = F.paydayAllocation(plan(), AS_OF, options([], {
  currentPeriodActuals: packet([{ ...other, pending: true }], { transactionCoverage: 'incomplete' }),
}));
assert.equal(incomplete.actualsCoverage.remainingClaim, 'unavailable');
assert.equal(incomplete.essentials.wanted, 450, 'incumbent remaining-days fallback');
assert.equal(incomplete.protectedPath.allocated, 250);
assert.equal(incomplete.unallocated, 4300, '5000 - 450 fallback - 250 observed');
const scarce = F.paydayAllocation(plan(1000), AS_OF, options([{ ...other, pending: true }]));
assert.equal(scarce.unallocated, 0);
assert.equal(scarce.extraDebt.allocated, 0);
assert.equal(scarce.protectedPath.wanted, 250);
assert.equal(scarce.protectedPath.allocated, 100);
assert.equal(scarce.identity, 1000);

// Incumbent possible-replacement flags: confirmed spend counts posted once;
// the unresolved pending twin is not new identity or a second cash hold.
check('flagged pending/posted pair', 4400, [
  tx(600, { id: 'posted', pendingPostedDuplicate: true }),
  { ...pending, id: 'pending', pendingPostedDuplicate: true },
], 300, 4100);

// Exercise the real observer's directed identity and sanitized packet path.
const mapping = { mappings: [{ providerAccountId: 'synthetic-cash',
  atlasRole: 'household-cash',
  canonical: { collection: 'startingCash', id: 'chequing-a', field: 'value' } }] };
const rawPending = { providerTransactionId: 'p', providerAccountId: 'synthetic-cash',
  plaidTransactionId: 'pending-link', date: '2026-09-01', amount: '600',
  pending: true, savingsPostingEvidence: 'pending', currency: 'cad', payee: 'Walmart', originalName: 'Walmart', categoryLabel: 'Groceries' };
const rawPosted = { ...rawPending, providerTransactionId: 's', pending: false, savingsPostingEvidence: 'posted',
  plaidTransactionId: 'posted-link', pendingTransactionId: 'pending-link' };
function observed(rows) {
  return O.sanitizedCurrentPeriodActuals({ asOf: AS_OF,
    transactionWindow: { startDate: START, endDate: AS_OF, complete: true },
    pendingCoverage: { complete: true }, transactions: rows,
  }, { plan: plan(), accountMap: mapping, asOf: AS_OF });
}
const before = observed([rawPending]);
const after = observed([rawPending, rawPosted]);
assert.equal(before.transactions.length, 1);
assert.equal(after.transactions.length, 1, 'directed link collapses the pending identity');
assert.equal(before.transactions[0].accountRole, 'household-cash');
assert.equal(after.transactions[0].pending, false);
const beforeAllocation = F.paydayAllocation(plan(), AS_OF, options([], { currentPeriodActuals: before }));
const afterAllocation = F.paydayAllocation(plan(4400), AS_OF, options([], { currentPeriodActuals: after }));
assert.equal(beforeAllocation.essentials.wanted, 300);
assert.equal(beforeAllocation.protectedPath.allocated, 600);
assert.equal(beforeAllocation.unallocated, 4100);
assert.equal(afterAllocation.essentials.wanted, 300);
assert.equal(afterAllocation.protectedPath.allocated, 0);
assert.equal(afterAllocation.unallocated, 4100);

// Partial pending coverage retains every observed cash debit; it is qualified.
const partial = F.paydayAllocation(plan(), AS_OF, options([], {
  currentPeriodActuals: packet([pending], { pendingCoverage: 'partial' }),
}));
assert.equal(partial.actualsCoverage.remainingClaim, 'posted-only');
assert.equal(partial.essentials.wanted, 300);
assert.equal(partial.protectedPath.allocated, 600);
assert.equal(partial.unallocated, 4100);
// Existing split, account, and non-consumption rules apply to cash holds too.
check('split parent is not a second pending debit', 5000, [
  { ...pending, id: 'parent', isGroup: true },
  { ...pending, id: 'child', parentId: 'parent' },
], 300, 4100, false, 600);
for (const extra of [
  { accountRole: 'household-external' }, { kindHint: 'transfer' },
  { representedBill: true },
  { amount: -600 }, { amount: -600, isIncome: true }, { date: '2026-09-05' },
]) {
  const a = F.paydayAllocation(plan(), AS_OF, options([{ ...pending, ...extra }]));
  assert.equal(a.essentials.wanted, 900, 'excluded actual cannot change essential cash');
  assert.equal(a.protectedPath.allocated, 0, 'excluded actual cannot encumber pending cash');
}
// A pending debit in an income category is money leaving that needs
// confirmation: uncategorised, so Groceries keeps its full 900 hold, and the
// 600 is still unsettled cash. 5000 - 900 - 600 = 3500 releasable.
check('income-category pending debit is still unsettled cash', 5000,
  [{ ...pending, isIncome: true }], 900, 3500, false, 600);
// An already-settled treatment is not still-unsettled cash.
check('incumbent confirmed-settled treatment', 4400, [
  { ...pending, pendingTreatment: 'confirmed-settled' },
], 300, 4100);
// No packet preserves the incumbent remaining-days planning fallback.
const absent = F.paydayAllocation(plan(), AS_OF, { debts: [], targetBuffer: 0, weeklyVariable: 0 });
assert.equal(absent.actualsCoverage.remainingClaim, 'unavailable');
assert.equal(absent.essentials.wanted, 450);
console.log('ALL CASH IDENTITY CHECKS PASSED');
