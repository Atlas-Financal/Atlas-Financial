'use strict';
// Independently invented ledgers. No provider/household balances or dates copied.
const source = require('./savings-daily-consumer-data');

function input(mode = 'valid-v2') {
  const data = source('ready');
  let asOf = data.meta.asOf;
  if (['prior-household-day', 'blocked-prior-day', 'household-midnight-current'].includes(mode)) {
    asOf = '2026-10-06';
    data.meta.asOf = data.plan.opening.asOf = asOf;
    data.liveOverlay.currentPeriodActuals.observationAsOf = data.liveOverlay.currentPeriodActuals.coverageThrough = asOf;
    data.liveOverlay.observedCash.asOf = asOf;
    data.liveOverlay.observedCash.accounts.forEach(row => { row.evidenceDate = asOf; });
  }
  const stamp = asOf + 'T19:00:00Z';
  const accounts = [
    { id: '9001', accountId: 'chequing-a', value: 200 },
    { id: '9002', accountId: 'chequing-b', value: 0 },
    { id: '9003', accountId: 'savings', value: 95 },
    { id: '9004', accountId: 'savings-dont-touch', value: 24 },
  ];
  const payload = { provider: 'lunchmoney', fetchedAt: asOf + 'T20:00:00Z',
    accounts: accounts.map(row => ({ id: row.id, type: 'depository', balance: String(row.value),
      currency: 'cad', ...(row.accountId.startsWith('chequing-') ? { updated_at: stamp, balance_last_update: stamp }
        : { balance_last_update: stamp, last_fetch: asOf + 'T19:30:00Z' }) })),
    transactions: [], categories: [],
    transactionWindow: { startDate: '2026-10-02', endDate: asOf, complete: true, hasMore: false, truncated: false },
    pendingCoverage: { complete: true, basis: 'is_pending-unbounded', hasMore: false, truncated: false } };
  const accountMap = { schema: 'atlas-provider-account-map/v1', provider: 'lunchmoney', scope: 'fixture',
    mappings: accounts.map(row => ({ providerAccountId: row.id,
      canonical: { collection: 'cash', id: row.accountId },
      atlasRole: row.accountId.startsWith('chequing-') ? 'household-cash' : 'household-reserve' })) };
  const savings = payload.accounts[2];
  if (mode === 'legacy-date') {
    for (const row of payload.accounts.slice(2)) { delete row.balance_last_update; row.balance_as_of = stamp; }
  }
  if (mode === 'legacy-over-null') { savings.balance_last_update = null; savings.balance_as_of = stamp; }
  if (mode === 'null-object-update') { savings.balance_last_update = null; savings.updated_at = stamp; }
  if (mode === 'null-legacy-fetch') { savings.balance_last_update = null; savings.date_last_fetched = stamp; }
  if (mode === 'null-v2-sync') savings.balance_last_update = null;
  if (mode === 'stale-date') { savings.balance_last_update = '2026-10-04T19:00:00Z'; savings.updated_at = stamp; }
  if (mode === 'stale-both') payload.accounts.slice(2).forEach(row => { row.balance_last_update = '2026-09-30T19:00:00Z'; });
  if (mode === 'prior-year') payload.accounts.slice(2).forEach(row => { row.balance_last_update = '2025-10-05T19:00:00Z'; });
  if (['prior-household-day', 'blocked-prior-day'].includes(mode)) payload.accounts.slice(2).forEach(row => { row.balance_last_update = '2026-10-06T04:30:00Z'; });
  if (mode === 'household-midnight-current') payload.accounts.slice(2).forEach(row => { row.balance_last_update = '2026-10-06T07:00:00Z'; });
  if (mode === 'withdrawal-stale') { savings.balance = '15.02'; savings.balance_last_update = '2026-10-04T19:00:00Z'; }
  if (mode === 'negative-stale') { savings.balance = '-27.12'; savings.balance_last_update = '2026-10-04T19:00:00Z'; }
  if (mode === 'zero-stale') payload.accounts.slice(2).forEach(row => { row.balance = '0'; row.balance_last_update = '2026-10-04T19:00:00Z'; });
  if (mode === 'future-date') { savings.balance_last_update = '2026-10-06T19:00:00Z'; savings.updated_at = stamp; }
  if (mode === 'malformed-date') { savings.balance_last_update = 'not-a-date'; savings.updated_at = stamp; }
  if (mode === 'malformed-type') { savings.balance_last_update = [asOf]; savings.updated_at = stamp; }
  if (mode === 'impossible-date') { savings.balance_last_update = '2026-02-30T19:00:00Z'; savings.updated_at = stamp; }
  if (mode === 'missing-date' || mode === 'sync-only') {
    delete savings.balance_last_update;
    if (mode === 'missing-date') delete savings.last_fetch;
  }
  if (mode === 'offset-date') savings.balance_last_update = '2026-10-06T02:00:00Z';
  if (mode === 'calendar-date') savings.balance_last_update = asOf;
  if (mode === 'v2-over-update') savings.updated_at = '2026-10-04T19:00:00Z';
  if (mode === 'foreign-currency') savings.currency = 'usd';
  if (mode === 'missing-account') payload.accounts.pop();
  if (mode === 'duplicate-account') payload.accounts.push({ ...savings });
  if (mode === 'pending-movement') payload.transactions.push({ id: 'invented-pending-reserve', account_id: '9003',
    date: asOf, amount: '5', currency: 'cad', is_pending: true, payee: 'Invented reserve movement' });
  if (['sender-unknown', 'blocked-prior-day'].includes(mode)) {
    data.debts = [{ id: 'card', label: 'Invented card', balance: 821.43, pending: 0, rate: 0, limit: 2000 }];
    data.plan.obligations.push({ id: 'card', debtId: 'card', effect: 'payment', label: 'Invented card minimum',
      frequency: 'monthly', day: 7, firstDue: '2026-10-07', amount: 47.39, confidence: 'estimated', payingAccount: 'chequing-a',
      statementOccurrences: [{ scheduledDate: '2026-10-07', dueDate: '2026-10-08',
        minimum: 47.39, currency: 'cad', confidence: 'confirmed' }],
      sentPayments: [{ scheduledDate: '2026-10-07', confirmed: true, intent: 'minimum',
        debitId: 'invented-debit', postedOn: asOf, amount: 47.39, currency: 'cad',
        fundingAccountId: 'chequing-a', pending: false }] });
  }
  return { data, payload, accountMap };
}

function served(mode, observer) {
  const x = input(mode);
  const report = observer.observe({ provider: 'lunchmoney', ...x });
  // Both packets cross the actual overlay boundary without fixture replacement.
  const data = require('../../scripts/live-plan').overlayLiveState({ data: x.data, report }).data;
  return { ...x, data, report };
}

module.exports = { input, served };
