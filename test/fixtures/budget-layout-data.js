'use strict';

// Minimal, invented household inputs for the real Forecast and routed UI.
// No provider IDs, transactions, account numbers or production balances.
module.exports = function budgetLayoutData() {
  return {
    meta: { asOf: '2026-12-19', title: 'Synthetic Budget review' },
    accounts: [], debts: [], revolvingExtra: [],
    plan: {
      windowDays: 91, opening: { asOf: '2026-12-19' },
      startingCash: { breakdown: [{ id: 'chequing-a', label: 'Bills account — synthetic',
        value: 2500, class: 'spendable' }, { id: 'chequing-b', value: 0 }] },
      defaults: { targetBuffer: 200, extraDebtMonthly: 0, scenario: 'expected' },
      budget: { basis: 'ytd', categories: [{ id: 'groceries', label: 'Groceries',
        class: 'essential', from: ['Groceries'], plannedPayday: 100 }] },
      obligations: [], commitments: [],
      bills: [
        { id: 'mortgage', label: 'Mortgage', amount: 1600, frequency: 'monthly',
          day: 1, confidence: 'confirmed' },
        { id: 'hydro', label: 'Hydro', amount: 199, frequency: 'monthly',
          day: 3, confidence: 'confirmed' },
      ],
      income: [{ id: 'payroll', label: 'Payroll — Seaspan', frequency: 'biweekly',
        anchor: '2026-08-14', amount: 4264, confidence: 'confirmed' }],
      payrollPlanningAssumptions: { salaryRaiseFactor: 1.04, bonusRate: 0,
        authorizedThroughYear: 2027 },
    },
  };
};
