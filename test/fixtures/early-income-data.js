'use strict';
// Independent invented ledger. No live household amounts or provider ids.
const identity = require('../../docs/connectivity/transaction-identity.json');
const clone = x => JSON.parse(JSON.stringify(x));
module.exports = function fixture(kind = 'amanda', control = 'early') {
  const payroll = kind === 'payroll', amount = payroll ? 2500 : 1800.25;
  const scheduled = payroll ? '2027-01-01' : '2026-10-31';
  const early = payroll ? '2026-12-31' : '2026-10-30';
  const asOf = control === 'same-day' ? scheduled : control === 'bracketed' ? '2026-11-01' : early;
  const transfer = control === 'bracketed' ? asOf : asOf;
  const sourceDate = control === 'bracketed' ? early : asOf;
  const prior = payroll ? '2026-12-30' : '2026-10-29';
  const id = payroll ? 'payroll' : 'amandaSalaryMonthEnd';
  const data = { meta: { asOf: prior, title: 'Invented early receipt fixture' }, accounts: [], debts: [], revolvingExtra: [],
    plan: { opening: { asOf: prior, representedEvents: [] }, windowDays: 28,
      startingCash: { breakdown: [
        { id: 'chequing-a', label: 'Invented Bills', value: 1000 },
        { id: 'chequing-b', label: 'Invented Weekly', value: 0 },
        { id: 'savings', label: 'Invented savings', value: 0 }] },
      defaults: { targetBuffer: 0, extraDebtMonthly: 0, scenario: 'expected' },
      income: [payroll ? { id, label: 'Invented payroll', frequency: 'biweekly', anchor: scheduled, amount, confidence: 'confirmed' }
        : { id, label: 'Invented employer salary', frequency: 'monthly', day: 31, firstDue: scheduled, amount, confidence: 'confirmed' }],
      bills: [], obligations: [], commitments: [], groups: [], funding: { options: [] }, budget: { categories: [] } } };
  const accounts = ['chequing-a', 'chequing-b', 'savings'];
  const accountMap = { schema: 'atlas-provider-account-map/v1', provider: 'lunchmoney', scope: 'fixture', mappings: [
    ...accounts.map((id, i) => ({ providerAccountId: 'invented-cash-' + i, canonical: { collection: 'cash', id }, atlasRole: 'household-cash' })),
    { providerAccountId: 'invented-employer-source', atlasRole: 'household-external', externalId: 'tennis-income' }] };
  const identityRules = clone(identity.rules).filter(rule => ['payroll', 'amandaSalary15', 'amandaSalaryMonthEnd'].includes(rule.eventId))
    .map(rule => rule.eventId === 'payroll' ? { ...rule, payeePattern: 'INVENTED PAYROLL EMPLOYER' }
      : { ...rule, salaryReceiptPayeePatterns: ['INVENTED TENNIS EMPLOYER PAY'] });
  const tx = (id, account_id, date, amount, payee, category_name) => ({ id, account_id, date, amount, payee,
    category_name, currency: 'cad', is_income: category_name === 'Income', is_pending: false });
  const transactions = control === 'unpaid' ? [] : payroll
    ? [tx('invented-payroll-receipt', 'invented-cash-0', sourceDate, -amount, 'INVENTED PAYROLL EMPLOYER PAY', 'Income')]
    : [tx('invented-employer-receipt', 'invented-employer-source', sourceDate, -amount, 'INVENTED TENNIS EMPLOYER PAY', 'Income'),
      tx('invented-transfer-debit', 'invented-employer-source', transfer, amount, 'INVENTED TRANSFER', 'Transfer'),
      tx('invented-transfer-credit', 'invented-cash-0', transfer, -amount, 'INVENTED TRANSFER', 'Transfer')];
  const payload = { provider: 'lunchmoney', fetchedAt: asOf + 'T18:00:00.000Z',
    accounts: accountMap.mappings.map((mapping, i) => ({ id: mapping.providerAccountId, name: 'Invented account ' + i,
      type: 'depository', currency: 'cad', balance: i ? 0 : control === 'unpaid' ? 1000 : 1000 + amount,
      balance_as_of: asOf, updated_at: asOf + 'T17:00:00.000Z', balance_last_update: asOf + 'T17:00:00.000Z' })), transactions,
    transactionWindow: { startDate: prior, endDate: asOf, complete: true, hasMore: false, truncated: false },
    pendingCoverage: { complete: true, basis: 'is_pending-unbounded', hasMore: false, truncated: false } };
  return { data, accountMap, identityRules, payload, asOf, scheduled, amount, id };
};
