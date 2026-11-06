'use strict';
// Invented private-history capture input for storage-backend tests. Same shape
// as the builder in test/test-private-period-history.js; every identity,
// amount and string is synthetic. `sentinel` puts a marker into provider-only
// free text (payee, merchant, notes, tag, account name, ids) so a test can prove
// none of it reaches a stored projection.
const History = require('../../scripts/private-period-history');

const START = '2030-02-01', END = '2030-02-14', NEXT = '2030-02-15';
function input({ day = START, kind = 'original', periodStart = START, cash = [1000, 500, 100], sentinel = 'Invented',
  capturedAt = day + 'T18:01:00Z', bills = [] } = {}) {
  const ids = ['chequing-a', 'chequing-b', 'savings'];
  const rows = ids.map((id, i) => ({ id, label: 'Invented cash ' + i, value: cash[i], evidenceDate: day, confidence: 'confirmed' }));
  return {
    kind, capturedAt, periodStart, periods: [],
    ...(kind === 'actual-correction' ? { reason: 'invented source revision' } : {}),
    data: { meta: { asOf: day }, accounts: [], debts: [], revolvingExtra: [], plan: {
      opening: { asOf: day, representedEvents: [] }, startingCash: { breakdown: rows },
      defaults: { targetBuffer: 0, extraDebtMonthly: 0 },
      income: [{ id: 'payroll', label: 'Invented income', frequency: 'biweekly', anchor: START, amount: 200, confidence: 'confirmed' }],
      bills, commitments: [], obligations: [], groups: [], funding: { options: [] },
      budget: { categories: [['groceries', 40], ['fuel', 15], ['restaurants', 10], ['dale-guilt-free', 5],
        ['amanda-guilt-free', 5], ['pets', 5], ['other-spend', 20]].map(([id, plannedPayday]) =>
        ({ id, label: 'Invented ' + id, plannedPayday, class: 'essential', confidence: 'confirmed', from: [] })) },
    } },
    accountMap: { provider: 'lunchmoney', schema: 'atlas-provider-account-map/v1', scope: 'owner-observed', mappings: ids.map((id, i) =>
      ({ providerAccountId: sentinel + '-account-' + i, atlasRole: 'household-cash', canonical: { id, collection: 'cash' } })) },
    identity: { rules: [], billPaymentPayees: [] },
    payload: { provider: 'lunchmoney', fetchedAt: day + 'T18:00:00Z',
      accounts: rows.map((row, i) => ({ id: sentinel + '-account-' + i, name: sentinel + ' provider cash ' + i,
        currency: 'cad', balance: row.value, balance_as_of: day + 'T17:59:00Z', updated_at: day + 'T17:59:00Z', balance_last_update: day + 'T17:59:00Z' })),
      categories: [{ id: 'invented-category', name: 'Groceries' }], tags: [{ id: sentinel + '-tag', name: sentinel + ' household note' }],
      transactions: [{ id: sentinel + '-transaction', account_id: sentinel + '-account-1', date: START, amount: '12.34', currency: 'cad',
        category_id: 'invented-category', payee: sentinel + ' Market', original_name: sentinel.toUpperCase() + ' MARKET SOURCE',
        notes: sentinel + ' evidence', tags: [sentinel + '-tag'], is_pending: false, updated_at: day + 'T17:58:00Z', balance_last_update: day + 'T17:58:00Z' }],
      transactionWindow: { startDate: periodStart, endDate: day, complete: true, hasMore: false, truncated: false },
      pendingCoverage: { complete: true, basis: 'is_pending-unbounded', hasMore: false },
    },
  };
}
function capture(data) {
  const clean = JSON.parse(JSON.stringify(data)), time = clean.capturedAt; delete clean.capturedAt;
  return History.capture(clean, { now: () => new Date(time) });
}
module.exports = { START, END, NEXT, input, capture };
