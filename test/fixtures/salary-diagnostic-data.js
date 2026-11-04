'use strict';
// Reuses independently invented receipt ledgers, never live household cents.
const fx = require('./budget-income-receipts');
const clone = x => JSON.parse(JSON.stringify(x));
function input(mode = 'matched') {
  const data = fx.data(), accountMap = clone(fx.accountMap), identityRules = clone(fx.rules);
  const rows = fx.transactions();
  const row = id => rows.find(x => x.providerTransactionId === id);
  const rules = identityRules.filter(x => x.eventId.startsWith('amandaSalary'));
  if (mode === 'missing-identity') rules.forEach(x => { delete x.counterpartExternalId; });
  if (mode === 'empty-identity') rules.forEach(x => { x.counterpartExternalId = ' '; });
  if (mode === 'wrong-identity') accountMap.mappings[2].externalId = 'invented-different-private-identity';
  if (mode === 'wrong-role') accountMap.mappings[2].atlasRole = 'household-reserve';
  if (mode === 'ineligible-rule') rules.forEach(x => { x.direction = 'debit'; });
  if (mode === 'missing-rule') identityRules.splice(1);
  for (const id of ['credit', 'debit', 'salary']) {
    if (mode === 'pending-' + id) row(id).pending = true;
    if (mode === 'foreign-' + id) row(id).currency = 'usd';
    if (mode === 'malformed-' + id) row(id).date = 'not-a-date';
  }
  if (mode === 'missing-receipt') rows.splice(rows.indexOf(row('salary')), 1);
  if (mode === 'wrong-alias') row('salary').payee = 'INVENTED COACHING RECEIPT';
  if (mode === 'wrong-amount') row('salary').amount = -1733.17;
  if (mode === 'not-income') row('salary').isIncome = false;
  if (mode === 'late-receipt') row('salary').date = '2026-07-02';
  if (mode === 'missing-counterpart') rows.splice(rows.indexOf(row('debit')), 1);
  if (mode === 'duplicate-counterpart') rows.push({ ...row('debit'), providerTransactionId: 'invented-second-debit' });
  if (mode === 'duplicate-receipt') rows.push({ ...row('salary'), providerTransactionId: 'invented-second-receipt' });
  if (mode === 'final-ambiguity') rows.push({ ...row('credit'), providerTransactionId: 'invented-second-credit' });
  if (mode === 'wrong-source-account') {
    accountMap.mappings.push({ providerAccountId: 'invented-other-external', atlasRole: 'household-external', externalId: 'tennis-income' });
    row('salary').providerAccountId = 'invented-other-external';
  }
  if (mode === 'multiple-occurrences') row('salary').date = '2026-06-14';
  if (mode === 'no-occurrence') for (const id of ['salary', 'credit', 'debit']) row(id).date = '2026-07-02';
  const payload = { provider: 'lunchmoney', fetchedAt: fx.AS_OF + 'T18:00:00Z',
    accounts: accountMap.mappings.map((mapping, i) => ({ id: mapping.providerAccountId,
      name: mode === 'renamed' ? 'RENAMED PRIVATE LABEL' : 'PRIVATE ACCOUNT LABEL',
      type: 'depository', balance: String(i ? 400 : 3000), currency: 'cad',
      balance_as_of: fx.AS_OF, updated_at: fx.AS_OF + 'T17:00:00Z', balance_last_update: fx.AS_OF + 'T17:00:00Z' })),
    transactions: rows.map(x => ({ id: x.providerTransactionId, account_id: x.providerAccountId,
      date: x.date, amount: x.amount, currency: x.currency, payee: x.payee,
      category_name: x.categoryLabel, is_income: x.isIncome, is_pending: x.pending,
      notes: 'PRIVATE RAW NOTE SENTINEL', original_name: 'PRIVATE ORIGINAL NAME SENTINEL' })),
    transactionWindow: { startDate: mode === 'multiple-occurrences' ? '2026-06-01' : '2026-06-25',
      endDate: fx.AS_OF, complete: true, hasMore: false, truncated: false },
    pendingCoverage: { complete: true, basis: 'is_pending-unbounded', hasMore: false, truncated: false } };
  if (mode === 'incomplete-window') payload.transactionWindow.complete = false;
  if (mode === 'malformed-window') payload.transactionWindow.startDate = 'not-a-date';
  if (mode === 'missing-window') delete payload.transactionWindow;
  return { provider: 'lunchmoney', data, accountMap, identityRules, payload };
}
module.exports = { input };
