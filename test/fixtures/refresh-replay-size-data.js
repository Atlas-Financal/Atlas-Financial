'use strict';
// Invented household and provider rows. Only collection sizes follow the
// count-only 2026-11-13 v2 observation; no household values or identifiers do.
// 1,001 rows, seven pending, 82 distinct dates across a 99-day lookback
// (Aug 6-Nov 13, 100 inclusive calendar dates);
// 107 recurring-linked rows, three matching the invented configured item.
// The existing invented world supplies 33 bills, seven debts, eight
// obligations, four incomes, 17 dated costs and the 2027 payroll walk.
const World = require('./held-other-income-search-world');
const AS_OF = '2026-11-13';
const RECURRING_ID = '88';
const CATEGORY_ID = '77';

function build() {
  const data = World.build({ asOf: AS_OF, walk: true, transactions: 0, days: 99 });
  delete data.liveOverlay;
  data.plan.budget.categories.push({ id: 'pets', label: 'Invented pets',
    class: 'essential', plannedPayday: 80, confidence: 'confirmed',
    dogFoodLunchMoneyRecurringIds: [RECURRING_ID],
    dogFoodLunchMoneyCategoryIds: [CATEGORY_ID] });
  const stamp = AS_OF + 'T18:00:00.000Z';
  const map = { schema: 'atlas-provider-account-map/v1', provider: 'lunchmoney',
    scope: 'fixture', mappings: [] };
  const accounts = [];
  data.plan.startingCash.breakdown.forEach((row, i) => {
    const id = 1001 + i;
    map.mappings.push({ providerAccountId: String(id),
      canonical: { collection: 'cash', id: row.id },
      atlasRole: row.id === 'savings' ? 'household-reserve' : 'household-cash' });
    accounts.push({ id, type: 'cash', balance: row.value, currency: 'cad',
      updated_at: stamp, balance_as_of: stamp });
  });
  data.debts.forEach((row, i) => {
    const id = 2001 + i;
    map.mappings.push({ providerAccountId: String(id),
      canonical: { collection: 'debts', id: row.id },
      atlasRole: row.id === 'loan' ? 'mortgage' : row.id === 'loc' ? 'heloc' : 'revolving-credit' });
    accounts.push({ id, type: 'credit', balance: row.balance,
      ...(row.limit != null ? { credit_limit: row.limit } : {}),
      currency: 'cad', updated_at: stamp, balance_as_of: stamp });
  });
  const dates = Array.from({ length: 82 }, (_, i) => World.addDays(AS_OF, -(i === 81 ? 99 : i)));
  const transactions = Array.from({ length: 1001 }, (_, i) => ({
    id: 90000 + i, account_id: 1001 + i % 2, date: dates[i % dates.length],
    amount: 6 + i % 20, currency: 'cad', payee: 'Invented merchant ' + i % 40,
    category_id: 11 + i % 3, is_pending: i < 7, status: 'cleared',
  }));
  for (let i = 0; i < 107; i++) transactions[i].recurring_id = 999;
  // Existing provider recurring-item links, not merchant-name matches.
  // Their boolean classification must survive the source replay projection.
  for (const i of [20, 21, 22]) Object.assign(transactions[i], {
    category_id: Number(CATEGORY_ID), recurring_id: Number(RECURRING_ID), date: dates[1] });
  const payload = { provider: 'lunchmoney', fetchedAt: stamp, accounts,
    categories: [{ id: 11, name: 'Groceries' }, { id: 12, name: 'Gas' },
      { id: 13, name: 'Restaurants' }, { id: Number(CATEGORY_ID), name: 'Pet supplies' }],
    tags: [], transactions,
    transactionWindow: { startDate: dates[81], endDate: AS_OF,
      complete: true, hasMore: false, truncated: false },
    pendingCoverage: { complete: true, hasMore: false, truncated: false,
      basis: 'is_pending-unbounded' } };
  return { data, payload, map };
}

module.exports = { build, AS_OF, RECURRING_ID, CATEGORY_ID };
