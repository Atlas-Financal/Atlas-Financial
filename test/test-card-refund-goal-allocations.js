'use strict';
// Root-cause pin for acceptance 2.14 (#962 D2). Invented numbers only; every
// expected figure is hand-worked, not read back from Forecast.
// A refund on a card row that the link publication attributes to a Savings
// item is classed 'savings-item' (direction 'refund'), not 'refund'. The aggregate
// card ledger used to treat such a credit as an unknown-purpose card credit,
// leave the item's card charge "unconfirmed", and so withhold every goal's
// Saved share. 150 from Savings + 80 on the card - 20 refunded; Savings pays
// the net card balance 60. The 790 pool backs Camp 300 and Christmas 100.
const assert = require('node:assert/strict');
const H = require('./acceptance/harness');
const F = require('../public/forecast');

function build(refund) {
  const w = H.baseWorld();
  const pool = refund ? 790 : 770, payment = refund ? 60 : 80;
  w.accounts.find(a => a.id === 'savings').value = pool;
  w.commitments = [
    { id: 'trip', label: 'Invented trip', date: '2026-11-20', amount: 600, confidence: 'confirmed', sinkingFund: true },
    { id: 'camp', label: 'Invented camp', date: '2026-12-01', amount: 300, confidence: 'confirmed', sinkingFund: true },
    { id: 'christmas', label: 'Invented Christmas', date: '2026-12-20', amount: 500, confidence: 'confirmed', sinkingFund: true },
  ];
  w.savingsPool = {};
  w.links = [{ categoryId: 106, goalRef: { kind: 'commitment', id: 'trip' }, occurrenceDate: '2026-11-20',
    effectiveFrom: '2026-09-01', effectiveThrough: '2026-12-31' }];
  w.accounts.push({ id: 'travelvisa', providerId: 9004, role: 'revolving-credit', collection: 'debts', label: 'Invented card', value: 0 });
  w.debts = [{ id: 'travelvisa', label: 'Invented card', structure: 'Revolving', secured: false, balance: 0,
    pending: 0, rate: 0, limit: 2000, statementCloseDay: 17 }];
  w.planPatch = plan => { plan.cardPurchaseCoverage = { rule: 'aggregate-per-card-per-pay-period',
    opening: { asOf: '2026-10-09', confirmed: true, currency: 'cad', fundingAccountId: 'chequing-a', purchases: [] } }; };
  w.transactions = [
    H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' }),
    H.lm({ date: '2026-10-10', amount: 150, category: 'Trip', account: 'savings', payee: 'Invented airline' }),
    H.lm({ date: '2026-10-11', amount: 80, category: 'Trip', account: 'travelvisa', providerAccountId: 9004, payee: 'Invented airline' }),
    H.lm({ date: '2026-10-13', amount: payment, account: 'savings', payee: 'Invented card payment', category: 'Transfer',
      raw: { category_name: 'Credit Card Payment' } }),
    H.lm({ date: '2026-10-13', amount: -payment, account: 'travelvisa', providerAccountId: 9004, payee: 'PAYMENT - THANK YOU',
      raw: { category_name: 'Credit Card Payment' } })];
  if (refund) w.transactions.push(H.lm({ date: '2026-10-12', amount: -20, category: 'Trip',
    account: 'travelvisa', providerAccountId: 9004, payee: 'Invented airline' }));
  const { data } = H.dataOf(H.productionOpening(w));
  const advice = F.recommend(data.plan, data.meta.asOf, { ...data.liveOverlay, debts: data.debts });
  return advice;
}

for (const refund of [false, true]) {
  const advice = build(refund);
  const codes = (advice.cardPurchaseCoverage.issues || []).map(i => i.code);
  assert(!codes.includes('coverage-payment-or-credit-purpose-unconfirmed'),
    (refund ? 'refund' : 'control') + ': a linked item refund is not an unknown-purpose card credit: ' + codes);
  const items = advice.savingsFunding.backing.items;
  assert.equal(advice.savingsFunding.backing.status, 'ready', advice.savingsFunding.backing.reason);
  assert.deepEqual(items.map(r => r.saved), refund ? [390, 300, 100] : [370, 300, 100],
    'every goal keeps its allocation (refund ' + refund + ')');
}
console.log('card refund goal allocations: ok');
