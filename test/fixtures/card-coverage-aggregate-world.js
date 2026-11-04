'use strict';
// Invented world for the aggregate card-coverage rule (owner, #787 6641053911).
const assert = require('node:assert/strict');
const F = require('../../public/forecast');
const Live = require('../../scripts/live-plan');
const source = require('./card-backfill-data');

const RULE = 'aggregate-per-card-per-pay-period';
// Invented world: payday anchor 2026-09-18 (periods 09-18..10-01, 10-02..10-15),
// Bills 500, card debt 400, groceries allowance 150, a 25 card minimum due on
// the as-of. Rows: [account, amount, date, kind, extra].
const ACCOUNT = { bills: 3001, weekly: 3002, savings: 3003, card: 3004, card2: 3005 };
let nextId = 90001;
function world(rows, opts = {}) {
  const x = source();
  x.asOf = opts.asOf || '2026-09-20';
  // The 25 card minimum (fixture obligation 'travel', debtId travelvisa).
  x.data.plan.obligations[0].date = opts.minimumDate || x.asOf;
  x.data.plan.cardPurchaseCoverage = opts.policy || { rule: RULE,
    opening: { asOf: '2026-09-18', confirmed: true, currency: 'cad', fundingAccountId: 'chequing-a', purchases: [] } };
  if (opts.twoCards) {
    x.data.debts.push({ id: 'mbna', label: 'Second invented card', structure: 'Revolving', secured: false,
      balance: 0, pending: 0, rate: 0, limit: 1000, statementCloseDay: 17 });
    x.accountMap.mappings.push({ providerAccountId: String(ACCOUNT.card2),
      canonical: { collection: 'debts', id: 'mbna' }, atlasRole: 'revolving-credit' });
    x.payload.accounts.push({ ...x.payload.accounts[3], id: ACCOUNT.card2, name: 'Invented mbna', balance: 0 });
  }
  const label = { purchase: ['Invented grocer', 'Groceries'], refund: ['Invented grocer', 'Groceries'],
    cash: ['TFR-TO C/C', 'Credit Card Payment'], credit: ['PAYMENT - THANK YOU', 'Credit Card Payment'] };
  x.payload.transactions = rows.map(([account, amount, date, kind, extra]) => ({ id: nextId++,
    account_id: ACCOUNT[account], date: date || x.asOf, amount, payee: label[kind][0], category_name: label[kind][1],
    is_pending: false, status: 'reviewed', currency: 'cad', notes: null, ...(extra || {}) }));
  const sum = account => rows.filter(r => r[0] === account).reduce((s, r) => s + r[1], 0);
  x.payload.accounts[0].balance = 500 - sum('bills');
  x.payload.accounts[1].balance = 0 - sum('weekly');
  x.payload.accounts[2].balance = 0 - sum('savings');
  x.payload.accounts[3].balance = 400 + sum('card');
  if (opts.twoCards) x.payload.accounts[4].balance = sum('card2');
  x.payload.fetchedAt = x.asOf + 'T18:00:00Z';
  x.payload.accounts.forEach(a => { a.updated_at = a.balance_last_update = x.asOf + 'T17:00:00Z'; });
  x.payload.transactionWindow = { ...x.payload.transactionWindow, startDate: opts.windowStart || '2026-09-18', endDate: x.asOf };
  return x;
}
function run(x, editPacket) {
  const before = JSON.stringify(x);
  const observed = Live.fromObservation(x);
  assert.equal(JSON.stringify(x), before, 'inputs are immutable');
  const packet = observed.data.liveOverlay.currentPeriodActuals;
  if (editPacket) editPacket(packet);
  const advice = F.recommend(observed.data.plan, x.asOf, { debts: observed.data.debts, currentPeriodActuals: packet });
  const period = advice.payPeriodViews.find(p => p.role === 'active');
  return { observed, packet, advice, period, coverage: advice.cardPurchaseCoverage };
}
module.exports = { RULE, world, run };
