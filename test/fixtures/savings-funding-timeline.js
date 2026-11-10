'use strict';
// Independently invented household, never copied/scaled from a live account.
const AS_OF = '2026-09-10';
const clone = value => JSON.parse(JSON.stringify(value));
function fixture() {
  return { opening: { asOf: AS_OF }, windowDays: 91,
    defaults: { targetBuffer: 20, extraDebtMonthly: 0, scenario: 'expected' },
    startingCash: { breakdown: [
      { id: 'chequing-a', value: 100 }, { id: 'chequing-b', value: -10 }, { id: 'savings', value: 50 },
    ], heldElsewhere: [{ id: 'savings-dont-touch', value: 30, class: 'purpose-reserve' }] },
    income: [{ id: 'payroll', label: 'Synthetic payroll', frequency: 'biweekly', anchor: AS_OF,
      amount: 500, confidence: 'confirmed' }],
    obligations: [{ id: 'required-a', label: 'Synthetic required payment', frequency: 'monthly',
      day: 18, amount: 30, effect: 'payment', confidence: 'confirmed' }],
    bills: [{ id: 'routine-a', label: 'Synthetic ordinary bill', frequency: 'monthly', day: 20,
      amount: 25, confidence: 'confirmed' },
    { id: 'annual-a', label: 'Synthetic annual cost', frequency: 'yearly', month: 9, day: 25,
      amount: 70, confidence: 'confirmed', firstDue: '2026-09-25', jointCash: false }],
    commitments: [
      { id: 'club-first', label: 'Synthetic first camp', group: 'camp-a', date: '2026-09-15', amount: 80,
        confidence: 'confirmed', adjustable: false, sinkingFund: true },
      { id: 'club-second', label: 'Synthetic second camp', group: 'camp-a', date: '2026-10-12', amount: 200,
        confidence: 'confirmed', adjustable: false, sinkingFund: true },
      { id: 'undated-a', label: 'Synthetic undated need', when: 'TBD', amount: 40,
        confidence: 'confirmed', adjustable: false, sinkingFund: true },
    ], groups: [{ id: 'camp-a', label: 'Synthetic camps', planSpendSummary: true }],
    budget: { basis: 'ytd', categories: [{ id: 'groceries', label: 'Synthetic groceries', class: 'essential', plannedWeekly: 35 }] },
    savingsEarmarks: { version: 1, currency: 'CAD', history: [], pools: [
      { id: 'sports-a', accountId: 'savings', label: 'Synthetic sports pool', role: 'purpose-reserve',
        purpose: 'Synthetic camps', goalRefs: [{ kind: 'group', id: 'camp-a' }, { kind: 'commitment', id: 'undated-a' }] },
      { id: 'home-a', accountId: 'savings-dont-touch', label: 'Synthetic home pool', role: 'purpose-reserve',
        reconciledOn: AS_OF, purpose: 'Synthetic annual cost', goalRefs: [{ kind: 'yearly-bill', id: 'annual-a' }] },
    ] }, savingsPoolObservation: { asOf: AS_OF, accounts: [
      { accountId: 'savings', value: 50, currency: 'CAD', source: 'provider-observe:lunchmoney',
        evidenceDate: AS_OF, pendingState: 'clear' },
      { accountId: 'savings-dont-touch', value: 30, currency: 'CAD', source: 'provider-observe:lunchmoney',
        evidenceDate: AS_OF, pendingState: 'clear' },
    ] } };
}
// Separate invented dated counterfactual for numeric projection oracles.
// The original fixture remains required-undated and must withhold.
function datedFixture() {
  const plan = fixture();
  Object.assign(plan.commitments.find(row => row.id === 'undated-a'), {
    date: '2026-12-01', label: 'Synthetic dated reserve need',
  });
  return plan;
}
module.exports = { AS_OF, fixture, datedFixture, clone };
