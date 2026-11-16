'use strict';
// "Future receipts in this period" must not list a planned one-off that has
// already arrived (an early, exact-amount credit settled it; its cash is in
// the opening). Invented ledger only. Source: PR #927 additional finding.
const assert = require('node:assert/strict');
const F = require('../public/forecast');
const fx = require('./fixtures/savings-daily-allocation-contract');
const { policy } = require('./fixtures/chronological-savings-data');

function fromToday(arrived) {
  const input = policy(fx.advance(fx.fixture(), '2026-10-07'));
  input.plan.income.push({ id: 'one-off', label: 'Invented one-off', frequency: 'once',
    date: '2026-10-12', amount: 30, confidence: 'estimated', incomeClass: 'other' });
  if (arrived) {
    input.plan.startingCash.breakdown[0].value += 30;
    input.opts.currentPeriodActuals.transactions.push({ id: 'early-credit', date: '2026-10-06',
      amount: -30, pending: false, currency: 'CAD', savingsPostingEvidence: 'posted',
      atlasAccountId: 'chequing-a', accountRole: 'household-cash', categoryLabel: 'Reimbursement',
      displayedPayee: 'Invented sender', originalMerchant: 'Invented sender' });
  }
  const advice = F.recommend(input.plan, input.asOf, { ...input.opts, debts: [] });
  const current = advice.payPeriodViews.find(row => row.timelineRole === 'current');
  return { current, packet: current.fromTodayFunding,
    row: (current.otherIncome?.items || []).find(r => r.id === 'one-off') };
}

const expected = fromToday(false);
const arrived = fromToday(true);
// Control: still expected, so it is a future receipt (30).
assert.equal(expected.row.status, 'arriving');
assert.equal(expected.packet.status, 'ready');
assert.equal(expected.packet.futureIncomeThisPeriod, 30);
// Arrived early: received, in cash, so nothing is still to come.
assert.equal(arrived.row.status, 'received');
assert.equal(arrived.row.alreadyInCash, true);
assert.equal(arrived.packet.status, 'ready');
assert.equal(arrived.packet.futureIncomeThisPeriod, 0,
  'an arrived one-off is not a future receipt');
// Cash now holds the 30; the money available to set aside is that cash, once:
// 30 more than the expected case, not 60.
assert.equal(arrived.packet.currentCash, expected.packet.currentCash + 30);
assert.equal(arrived.packet.availableNow, expected.packet.availableNow + 30);
assert.equal(arrived.packet.contribution, expected.packet.contribution);
assert.equal(arrived.packet.requiredOperatingCash, expected.packet.requiredOperatingCash);
console.log('PASS future receipts exclude a planned one-off that already arrived');
