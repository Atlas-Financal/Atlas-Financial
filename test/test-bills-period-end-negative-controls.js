'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const { cases } = require('./test-bills-period-end-balance');
const LmGroups = require('./lm-groups-fixture.js');
const lmGrouped = x => { x.plan = x.data.plan = LmGroups.groupPlan(x.plan);
  x.opts.currentPeriodActuals = x.data.liveOverlay.currentPeriodActuals = LmGroups.groupPacket(x.opts.currentPeriodActuals, x.plan); return x; };
const fx = (m => ({ ...m, requirementsFixture: (...a) => lmGrouped(m.requirementsFixture(...a)) }))(require('./fixtures/bills-period-end-balance-data'));
const unknown = fx.requirementsFixture(); unknown.plan.bills[0].amount = null;
const weekly = fx.requirementsFixture(); weekly.plan.bills[0].payingAccount = 'chequing-b';
cases.push({ name: 'native amount erased by display projection', input: unknown, expected: null },
  { name: 'native explicit other cash payer', input: weekly, expected: 976.85 });
const source = fs.readFileSync(require.resolve('../public/forecast'), 'utf8');
const controls = [
  ['include Weekly overdraft', 'cash + futureIncome - remainingBills', 'startingCashAmount(plan) + futureIncome - remainingBills', 'Weekly overdraft excluded'],
  ['double count the household hold', '- remainingHousehold - otherOutflows', '- target - otherOutflows', 'independent closing identity'],
  ['ignore a proven return', 'weeklyFunding = roundCent(weeklyFunding - mov.amount)', 'weeklyFunding = roundCent(weeklyFunding - Math.min(0, mov.amount))', 'paired Weekly return reduces funding'],
  ['minimum/prior debt becomes backfill', '(record.allocations || [])', '([{ purchaseRef: record.allocations?.[0]?.purchaseRef, amount: Math.abs(leg.amount) }])', 'independent closing identity'],
  ['discard pending/card cash floor', 'Math.max(0, target - funded, requiredCashFloor)', 'Math.max(0, target - funded)', 'pending Bills household cash remains protected after Weekly funding'],
  ['replay early income', 'if (calendarOccurrenceRepresented(representedIncome, observedIncome, event.id, event.date)) continue;', 'if (false) continue;', 'early received future salary is added to stock once'],
  ['release earlier carry', '- otherOutflows - additionalCardCash', '- otherOutflows', 'confirmed earlier card carry is additional cash once'],
  ['unknown is dollar zero', "status: amount == null ? 'unavailable' : 'ready'", "status: amount == null ? 'ready' : 'ready'", 'missing posted coverage'],
  ['erase native unknown before projection', 'validateNativeRemainingCash();', '/* native validation omitted */', 'native amount erased by display projection'],
  ['other cash accounts become Bills payments', 'if (cashAccounts.has(payer)) return false;', 'if (cashAccounts.has(payer)) return true;', 'native explicit other cash payer'],
];
for (const [name, from, to, caseName] of controls) {
  assert(source.includes(from), 'matched mutation: ' + name);
  const context = { module: { exports: {} } };
  vm.runInNewContext(source.replace(from, to), context, { timeout: 1000 });
  const c = cases.find(row => row.name === caseName), x = c.input;
  const result = context.module.exports.billsAccountPeriodBalance(x.plan, x.asOf, x.opts);
  const rejected = c.expected == null ? result.status !== 'unavailable' || result.amount !== null
    : typeof result.amount !== 'number' || Math.abs(result.amount - c.expected) > .005;
  assert(rejected, 'independent fixture rejected wrong implementation: ' + name);
}
console.log(`PASS ${controls.length} deliberately wrong Bills closing implementations rejected`);
