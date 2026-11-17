'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const F = require('../public/forecast');
const fx = require('./fixtures/bills-period-end-balance-data');
const LmGroups = require('./lm-groups-fixture.js');
let checks = 0;
const cases = [];
const check = (condition, label) => { assert(condition, label); checks++; };
const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < .005;
const hash = path => crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex');
const canonicalBefore = hash(require.resolve('../data.json'));
const run = (name, change, expected, reason, alignCash = true) => {
  const x = fx.fixture(); if (change) change(x);
  if (alignCash) x.opts.observedCash.accounts.find(r => r.id === 'chequing-a').value = x.plan.startingCash.breakdown[0].value;
  x.plan = LmGroups.groupPlan(x.plan); x.opts.currentPeriodActuals = LmGroups.groupPacket(x.opts.currentPeriodActuals, x.plan);
  const before = JSON.stringify(x);
  cases.push({ name, input: JSON.parse(before), expected });
  const result = F.billsAccountPeriodBalance(x.plan, x.asOf, x.opts);
  check(result.accountId === 'chequing-a' && result.scope === 'bills-only', name + ': account scope');
  check(result.source === 'Forecast.billsAccountPeriodBalance', name + ': owner');
  check(result.grantsSpendPermission === false, name + ': no spending permission');
  check(expected == null ? result.amount === null : near(result.amount, expected), name + ': amount ' + JSON.stringify(result));
  check(expected == null ? result.status === 'unavailable' : result.trust === 'estimated', name + ': truthful trust');
  if (reason) check(result.issues.some(row => row.code === reason), name + ': reason');
  check(JSON.stringify(x) === before, name + ': no input mutation');
  check(JSON.stringify(F.billsAccountPeriodBalance(x.plan, x.asOf, x.opts)) === JSON.stringify(result), name + ': repeat stability');
  return { x, result };
};
const base = run('independent closing identity', null, 1735.35);
check(near(base.result.household.target, 520.37), 'approved target');
check(near(base.result.household.funded, 359.86), 'mixed payment only allocates the 88.43 backfill');
check(near(base.result.household.remaining, 160.51), 'unfunded target');
check(near(base.result.futureIncome, 643.17), 'future income only');
check(near(base.result.remainingBills, 93.41) && near(base.result.otherOutflows, 27.19), 'remaining actual cash events');
run('Weekly overdraft excluded', x => { x.plan.startingCash.breakdown[1].value = -9876.54; }, 1735.35);
run('Savings excluded', x => { x.plan.startingCash.breakdown[2].value = 999999; }, 1735.35);
run('newer owner bank number not a baseline', x => { x.opts.ownerBankBalance = 7777.77; x.opts.inferredOpening = 9999; }, 1735.35);
run('all current target already funded', x => {
  x.opts.currentPeriodActuals.transactions[0].amount = 700;
  x.opts.currentPeriodActuals.transactions[1].amount = -700;
}, 1895.86);
run('paired Weekly return reduces funding', x => {
  x.opts.currentPeriodActuals.transactions.push(fx.tx('return-debit', 'chequing-b', fx.AS_OF, 43.29, 'Payment, Transfer', { displayedPayee: 'CD234 TFR-TO invented' }),
    fx.tx('return-credit', 'chequing-a', fx.AS_OF, -43.29, 'Payment, Transfer', { displayedPayee: 'CD234 TFR-FR invented' }));
  x.plan.startingCash.breakdown[0].value += 43.29;
}, 1735.35);
run('unfunded category overspending', x => { x.opts.currentPeriodActuals.transactions.push(fx.tx('extra-dining', 'chequing-b', fx.AS_OF, 223.33, 'Restaurants')); }, 1692.06);
run('overspend already funded directly from Bills', x => {
  x.opts.currentPeriodActuals.transactions.find(t => t.id === 'weekly-dining').amount = 220.15;
  x.opts.currentPeriodActuals.transactions.push(fx.tx('extra-dining', 'chequing-a', fx.AS_OF, 43.29, 'Restaurants'));
  x.plan.startingCash.breakdown[0].value -= 43.29;
}, 1692.06);
run('negative Bills balance retained', x => { x.plan.startingCash.breakdown[0].value = -400; x.plan.cardPurchaseCoverage = undefined; x.opts.currentPeriodActuals.transactions = x.opts.currentPeriodActuals.transactions.filter(t => !t.id.startsWith('card-')); }, -126.37);
run('missing posted coverage', x => { x.opts.currentPeriodActuals.transactionCoverage = 'truncated'; }, null, 'posted-window-incomplete');
run('duplicate Bills identity', x => { x.opts.currentPeriodActuals.transactions.push({ ...x.opts.currentPeriodActuals.transactions[0] }); }, null, 'posted-window-incomplete');
run('unmatched Weekly funding leg', x => { x.opts.currentPeriodActuals.transactions = x.opts.currentPeriodActuals.transactions.filter(t => t.id !== 'weekly-credit'); }, null, 'unpaired-bills-transfer');
run('mixed card payment purpose unknown', x => { x.plan.cardPurchaseCoverage.payments[0].otherPurpose = null; }, null, 'card-coverage-unavailable');
run('cross-period card opening unknown', x => { x.plan.cardPurchaseCoverage.opening.confirmed = false; }, null, 'card-coverage-unavailable');
run('unknown pending coverage', x => { x.opts.currentPeriodActuals.pendingCoverage = 'unknown'; }, null, 'pending-coverage-incomplete');
run('Bills account unknown is not zero', x => { x.plan.startingCash.breakdown[0].value = null; }, null, 'bills-cash-unavailable');
run('distinct equal amounts are not deduplicated by amount', x => {
  x.opts.currentPeriodActuals.transactions.push(fx.tx('another-grocery', 'chequing-a', fx.AS_OF, 31.27, 'Groceries'));
}, 1766.62);
run('pending Bills household cash remains protected after Weekly funding', x => {
  x.opts.currentPeriodActuals.transactions[0].amount = 700;
  x.opts.currentPeriodActuals.transactions[1].amount = -700;
  x.opts.currentPeriodActuals.transactions.push(fx.tx('pending-grocery', 'chequing-a', fx.AS_OF, 43.29, 'Groceries', { pending: true }));
}, 1852.57);
run('uncovered category card cash cannot be released by Weekly funding', x => {
  x.opts.currentPeriodActuals.transactions[0].amount = 700;
  x.opts.currentPeriodActuals.transactions[1].amount = -700;
  x.opts.currentPeriodActuals.transactions = x.opts.currentPeriodActuals.transactions.filter(t => !['card-debit', 'card-credit'].includes(t.id));
  x.plan.cardPurchaseCoverage.payments = [];
  x.plan.startingCash.breakdown[0].value += 111.11;
}, 1918.54);
run('confirmed earlier card carry is additional cash once', x => {
  x.plan.cardPurchaseCoverage.opening.purchases.push({ ref: 'invented-earlier-carry', accountId: 'travelvisa', date: '2026-08-13', amount: 48.19, covered: 0, categoryLabel: 'Groceries' });
}, 1687.16);
run('confirmed backfill reversal restores cash and unmet funding once', x => {
  x.opts.currentPeriodActuals.transactions.push(fx.tx('reversal-card', 'travelvisa', fx.AS_OF, 43.29, 'Credit Card Payment'),
    fx.tx('reversal-cash', 'chequing-a', fx.AS_OF, -43.29, 'Credit Card Payment'));
  x.plan.cardPurchaseCoverage.reversals.push({ paymentId: 'mixed-payment', confirmed: true, cardDebitRef: 'invented-reversal-card',
    cashCreditRef: 'invented-reversal-cash', allocations: [{ purchaseRef: 'invented-card-purchase', amount: 43.29 }], otherAmount: 0 });
  x.plan.startingCash.breakdown[0].value += 43.29;
}, 1735.35);
run('issuer-confirmed minimum and backfill split do not replay cash', x => {
  x.plan.obligations.push({ id: 'mixed-minimum', debtId: 'travelvisa', label: 'Invented mixed minimum', effect: 'payment',
    frequency: 'once', date: '2026-08-22', amount: 22.68, confidence: 'confirmed', payingAccount: 'chequing-a' });
  x.plan.opening.representedEvents.push({ id: 'mixed-minimum', date: '2026-08-22', effectiveAsOf: fx.AS_OF });
  x.plan.cardPurchaseCoverage.payments[0].otherPurpose = 'required-payment';
}, 1735.35);
run('early received future salary is added to stock once', x => {
  x.plan.opening.representedEvents.push({ id: 'partner', date: '2026-08-25', effectiveAsOf: fx.AS_OF });
  x.opts.currentPeriodActuals.representedActuals.push({ id: 'partner', date: '2026-08-25', actual: -643.17, postedOn: fx.AS_OF, transactionId: 'early-income' });
  x.opts.currentPeriodActuals.transactions.push(fx.tx('early-income', 'chequing-a', fx.AS_OF, -643.17, 'Income', { isIncome: true }));
  x.plan.startingCash.breakdown[0].value += 643.17;
}, 1735.35);
run('accepted dated provider lag is usable without a new schema', x => {
  x.plan.opening.asOf = '2026-08-19';
  x.opts.observedCash.accounts[0].evidenceDate = '2026-08-19';
  x.opts.currentPeriodActuals.transactions.filter(t => t.date === fx.AS_OF).forEach(t => { t.date = '2026-08-19'; });
}, 1735.35);
run('newer posted cash cannot be mixed with an older seed', x => {
  x.opts.observedCash.accounts[0].evidenceDate = '2026-08-19';
}, null, 'cash-observation-misaligned');
run('contradictory observed cash cannot be an override', x => {
  x.opts.observedCash.accounts[0].value = 7777.77;
}, null, 'cash-observation-misaligned', false);
check(hash(require.resolve('../data.json')) === canonicalBefore, 'canonical baseline unchanged');
console.log(`PASS Bills period-end balance: ${checks} independent assertions`);
module.exports = { cases };
