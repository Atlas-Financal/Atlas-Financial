'use strict';
// Invented ledger only. No canonical balances, household dates or transaction IDs.
module.exports = function fixture(month = '04', payee = 'Shaw Cable') {
  const opening = month === '04' ? '2031-04-04' : '2031-05-02';
  const date = `2031-${month}-14`, asOf = `2031-${month}-15`;
  const ids = ['chequing-a', 'chequing-b', 'savings'];
  const data = { meta: { asOf: opening }, accounts: [], revolvingExtra: [], debts: [], plan: {
    opening: { asOf: opening }, windowDays: 28,
    startingCash: { breakdown: ids.map((id, i) => ({ id, label: 'Invented ' + id, value: [500, 100, 0][i] })) },
    defaults: { targetBuffer: 0, extraDebtMonthly: 0 },
    income: [{ id: 'invented-payroll', label: 'Seaspan - invented calendar', frequency: 'biweekly',
      anchor: opening, amount: 1000, confidence: 'confirmed' }],
    bills: [{ id: 'shaw', label: 'Invented internet bill', frequency: 'monthly', day: 14,
      amount: 17.23, confidence: 'confirmed', payingAccount: 'chequing-a', budgetCategory: 'telecom' }],
    obligations: [], commitments: [], budget: { categories: [
      { id: 'groceries', label: 'Groceries', class: 'essential', plannedPayday: 150, plannedWeekly: 75, confidence: 'confirmed' },
      { id: 'telecom', label: 'Phones & internet', from: ['Telecom'], plannedMonthly: 17.23, confidence: 'confirmed' },
    ] },
  } };
  const accountMap = { schema: 'atlas-provider-account-map/v1', provider: 'lunchmoney', scope: 'fixture',
    mappings: ids.map((id, i) => ({ providerAccountId: String(3001 + i),
      canonical: { collection: 'cash', id }, atlasRole: 'household-cash' })) };
  const payload = { provider: 'lunchmoney', fetchedAt: asOf + 'T18:00:00Z',
    accounts: ids.map((id, i) => ({ id: 3001 + i, name: 'Invented ' + id, type: 'cash', subtype: 'checking',
      institution_name: 'Invented institution', currency: 'cad', balance: [482.77, 100, 0][i], updated_at: asOf + 'T17:00:00Z', balance_last_update: asOf + 'T17:00:00Z' })),
    transactionWindow: { startDate: opening, endDate: asOf, complete: true, hasMore: false, truncated: false },
    pendingCoverage: { complete: true, basis: 'is_pending-unbounded', hasMore: false, startDate: null, endDate: null },
    categories: [{ id: 9911, name: 'Internet and cable', is_income: false, is_group: false,
      archived: false, exclude_from_budget: false, exclude_from_totals: false }], tags: [],
    transactions: [{ id: 'invented-shaw-payment', account_id: 3001, date, amount: 17.23, currency: 'cad',
      is_pending: false, category_id: 9911, payee, original_name: 'SHAW CABLE TV BPY', notes: null }],
  };
  return { data, payload, accountMap, asOf };
};
