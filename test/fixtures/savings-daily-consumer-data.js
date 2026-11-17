'use strict';
// Independent invented ledger, wrapped for the real authenticated-page consumer.
const fx = require('./savings-daily-allocation-contract');
const LmGroups = require('../lm-groups-fixture.js');
module.exports = function dailyConsumerData(mode = 'ready') {
  const input = fx.fixture();
  input.plan.savingsEarmarks.allocationPolicy = { order: 'due-date-first-combined-pool',
    effectiveFrom: '2026-10-05', source: 'Independent invented owner policy' };
  if (mode === 'before-policy') fx.advance(input, '2026-10-04');
  if (mode === 'ranged-need') {
    delete input.plan.commitments[1].amount;
    input.plan.commitments[1].amountMin = 170;
    input.plan.commitments[1].amountMax = 190;
  }
  if (mode === 'fully-backed') {
    input.plan.savingsPoolObservation.accounts[0].value = 230;
    input.plan.startingCash.breakdown[2].value = 230;
  }
  // These positive balances include the posted moves: October 4 legs precede
  // October 5 reports. Same-day ambiguity has its own negative controls.
  const posted = (amount, reference = 'AA101') => fx.transfer(input, amount, reference, 'savings', '2026-10-04');
  if (mode === 'partial') posted(30);
  if (mode === 'full') posted(80);
  if (mode === 'multiple') { posted(30); posted(20, 'BB202'); }
  if (mode === 'returned') {
    posted(80); posted(-20, 'CC303');
    input.opts.currentPeriodActuals.transactions.at(-2).originalMerchant = 'CC303 TFR-FR Invented reserve';
    input.opts.currentPeriodActuals.transactions.at(-1).originalMerchant = 'CC303 TFR-TO Invented operating';
  }
  if (mode === 'pending') { posted(30); input.opts.currentPeriodActuals.transactions.slice(-2).forEach(tx => { tx.pending = true; }); }
  if (mode === 'unmatched') { posted(30); input.opts.currentPeriodActuals.transactions.pop(); }
  if (mode === 'missing-stock') input.plan.savingsPoolObservation.accounts.pop();
  if (mode === 'missing-cash') delete input.plan.startingCash.breakdown[0].value;
  if (mode === 'saved-income') {
    input.plan.commitments[1].amount = 500;
    input.plan.startingCash.breakdown[0].value += 500; input.plan.opening.paydaySnapshot.opening += 500;
    input.plan.savingsPoolObservation.accounts[0].value += 80; input.plan.startingCash.breakdown[2].value += 80;
    input.opts.currentPeriodActuals.transactions.push({ id: 'saved-income', date: '2026-10-04', amount: -80,
      savingsPostingEvidence: 'posted',
      pending: false, currency: 'CAD', atlasAccountId: 'savings', accountRole: 'household-reserve',
      isIncome: true, displayedPayee: 'Invented saved gift' });
  }
  const data = require('./budget-funding-data')();
  data.meta = { asOf: input.asOf, title: 'Invented daily Savings consumer review' };
  // Slice 1: the invented categories sit in invented Lunch Money groups.
  data.plan = LmGroups.groupPlan(input.plan);
  data.liveOverlay = { applied: true, operatingPlan: 'live',
    currentPeriodActuals: LmGroups.groupPacket(input.opts.currentPeriodActuals, data.plan),
    observedCash: { asOf: input.asOf, complete: true, accounts: input.plan.startingCash.breakdown
      .filter(row => row.id.startsWith('chequing')).map(row => ({ ...row, evidenceDate: input.asOf })) } };
  return data;
};
