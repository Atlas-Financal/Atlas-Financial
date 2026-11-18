'use strict';
// Invented small amounts for independent Budget arithmetic; no provider data.
module.exports = function budgetFundingData() {
  return { meta: { asOf: '2026-08-14', title: 'Synthetic Budget funding review' },
    accounts: [], debts: [], revolvingExtra: [],
    plan: { windowDays: 28, opening: { asOf: '2026-08-14' },
      startingCash: { breakdown: [{ id: 'chequing-a', label: 'Bills — synthetic', value: 0 }, { id: 'chequing-b', value: 0 }] },
      defaults: { targetBuffer: 0, extraDebtMonthly: 0 },
      income: [{ id: 'payroll', label: 'Payroll — Seaspan', frequency: 'biweekly',
        anchor: '2026-08-14', amount: 1000, confidence: 'confirmed' }],
      bills: [{ id: 'bill', label: 'Required bill', frequency: 'biweekly',
        anchor: '2026-08-14', amount: 200, confidence: 'confirmed' },
      { id: 'later-bill', label: 'Later bill', frequency: 'once', date: '2026-08-28',
        amount: 150, confidence: 'confirmed' }],
      obligations: [],
      budget: { categories: [{ id: 'groceries', label: 'Groceries', class: 'essential',
        plannedPayday: 300, plannedWeekly: 150, confidence: 'confirmed' }] },
      commitments: [{ id: 'named-cost', label: 'Named cost', date: '2026-09-10',
        amount: 600, confidence: 'confirmed' }],
    } };
};
