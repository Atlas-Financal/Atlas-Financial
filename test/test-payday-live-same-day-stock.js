'use strict';
/* Hunt 2 H2-10, desk ruling (Plan #6, choice (a)), quoted:
 *   "require `opts.operatingPlan === 'live'`, `plan.opening.asOf` and `opts.observedCash.asOf` both
 *   equal to the financial payday, and one qualified `opts.observedCash.accounts` row for `chequing-a`
 *   with that `evidenceDate` and a finite posted value matching the opening's Bills row. … A fetch
 *   timestamp, opening date, `priorAsOf`, or matching amount alone is not proof. Check representation
 *   for the exact payroll occurrence with Forecast's existing rule. If payroll is unrepresented, don't
 *   add it to that same-day provider stock. Withhold the dependent allocation unless the existing,
 *   independently qualified pre-payday path can supply the base; don't fall back to the dated contract
 *   just because a live feed is incomplete. Keep the established pre-payroll behavior for eligible
 *   dated/owner openings. Test same-day overlay without a date advance, already-represented payroll
 *   counted once, and the dated control through both publications."
 *
 * Invented household only: payday 2026-10-09, Bills 3,000.00 posted that day, one 2,000.00 biweekly
 * payroll on it. Every expected figure is written by hand. The two publications are
 * paydayAllocation (available) and householdCurrentBalance (its currentBalancePublication).
 *
 * `node test/test-payday-live-same-day-stock.js`
 */
const cp = require('node:child_process');
const vm = require('node:vm');
const F = require('../public/forecast');
const A = require('../scripts/assistant-packet');

// The previous engine is the regression reference for the dated control only.
const BASE = '7b3e0b53f12b730b2cd065a971338852cee1483a';
const prior = { module: { exports: {} }, console };
vm.runInNewContext(cp.execFileSync('git', ['show', BASE + ':public/forecast.js'],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }), prior);
const OLD = prior.module.exports;

let checks = 0, failures = 0;
const ok = (cond, label, detail) => { checks++; if (cond) console.log('  PASS  ' + label); else { failures++; console.log('  FAIL  ' + label + (detail ? ' — ' + detail : '')); } };
const P = '2026-10-09';
function plan({ represented = false, base = false } = {}) {
  return {
    opening: { asOf: P,
      ...(represented ? { representedEvents: [{ id: 'payroll', date: P }] } : {}),
      // The live refresh's retained walk of the gap through the day before payday (independently qualified).
      ...(base ? { prePaydayBillsBase: { payday: P, accountId: 'chequing-a', coverageComplete: true, amount: 1000,
        fromAsOf: '2026-10-07', through: '2026-10-08' } } : {}) },
    startingCash: { asOf: P, breakdown: [
      { id: 'chequing-a', value: 3000, confidence: 'confirmed', evidenceDate: P },
      { id: 'chequing-b', value: 0, confidence: 'confirmed', evidenceDate: P }] },
    income: [{ id: 'payroll', label: 'Payroll — Seaspan', frequency: 'biweekly', anchor: P, amount: 2000, confidence: 'confirmed' }],
    bills: [], obligations: [], commitments: [], budget: { categories: [] },
  };
}
const observed = (value = 3000, extra = {}) => ({ complete: true, asOf: P, accounts: [
  { id: 'chequing-a', value, evidenceDate: P, ...extra }, { id: 'chequing-b', value: 0, evidenceDate: P }] });
const live = (o = {}) => ({ operatingPlan: 'live', observedCash: observed(), ...o });
const alloc = (p, o = {}, engine = F) => engine.paydayAllocation(p, P, { weeklyVariable: 0, debts: [], ...o });
const withheld = a => a.status === 'unavailable' && a.paydayBalance && a.paydayBalance.code === 'payday-balance-unproven'
  && a.available === null && Object.entries(a.paydayShellTrust).every(([k, t]) => k === 'buffer' || t === 'unknown');

console.log('1. Same-day live overlay, no date advance, payroll unrepresented: not added; withheld');
{
  const a = alloc(plan(), live());
  ok(withheld(a), 'paydayAllocation withholds (no 3,000.00 + 2,000.00 = 5,000.00)', JSON.stringify([a.status, a.available]));
  ok(a.currentBalancePublication.status === 'unavailable' && a.currentBalancePublication.amount === null,
    'householdCurrentBalance refuses too: the two publications agree');
  ok(a.opening === 3000 && a.todayIncome === 2000, 'its inputs are still reported as they are');
  const old = alloc(plan(), live(), OLD);
  ok(old.available === 5000 && old.paydayShellTrust.available === 'calculated',
    'reproduced: the previous engine published 5,000.00 as calculated beside the refusal');
}

console.log('2. Already-represented payroll is counted once');
{
  const a = alloc(plan({ represented: true }), live());
  ok(a.available === 3000 && a.todayIncome === 0 && a.paydayShellTrust.available === 'calculated' && !a.paydayBalance,
    'paydayAllocation: 3,000.00 (the payroll is inside the balance, not added again)');
  ok(a.currentBalancePublication.amount === 3000, 'householdCurrentBalance: 3,000.00');
}

console.log('3. The dated control keeps the established pre-payroll reading, in both publications');
{
  const a = alloc(plan()), old = alloc(plan(), {}, OLD);
  ok(a.available === 5000 && a.paydayShellTrust.available === 'calculated' && !a.paydayBalance,
    'a dated opening on the payday: 3,000.00 + 2,000.00 = 5,000.00, calculated');
  ok(JSON.stringify(a) === JSON.stringify(old), 'the whole dated allocation equals the previous engine');
  ok(JSON.stringify(a.currentBalancePublication) === JSON.stringify(old.currentBalancePublication),
    'its Current Balance publication equals the previous engine');
  const dated = alloc(plan(), { operatingPlan: 'dated' });
  ok(dated.available === 5000 && !dated.paydayBalance, 'operatingPlan "dated" reads the same');
}

console.log('4. An incomplete or unqualified live feed does not fall back to the dated contract');
{
  const cases = [
    ['no observed cash', live({ observedCash: undefined })],
    ['observed cash dated another day', live({ observedCash: { ...observed(), asOf: '2026-10-08' } })],
    ['a Bills row not matching the opening', live({ observedCash: observed(2999.99) })],
    ['a Bills row of unknown value', live({ observedCash: observed(3000, { unknown: true }) })],
    ['a Bills row with an estimated tag', live({ observedCash: observed(3000, { confidence: 'estimated' }) })],
    ['two Bills rows', live({ observedCash: { ...observed(), accounts: [...observed().accounts, { id: 'chequing-a', value: 3000, evidenceDate: P }] } })],
  ];
  for (const [name, o] of cases) ok(withheld(alloc(plan(), o)), `${name}: withheld, never 5,000.00`);
}

console.log('5. The independently qualified pre-payday base supplies the Bills part');
{
  // Base 1,000.00 at the day before payday; one 40.00 posted Bills debit today; payroll 2,000.00.
  // Current Balance: 1,000.00 - 40.00 + 2,000.00 = 2,960.00. Available: 3,000.00 opening - 3,000.00
  // Bills row + 2,960.00 = 2,960.00, estimated (the payroll is planned, not yet confirmed).
  const packet = { schema: 'atlas-current-period-actuals/v1', coverageStart: P, coverageThrough: P, observationAsOf: P,
    transactionCoverage: 'complete', pendingCoverage: 'complete',
    transactions: [{ id: 't1', date: P, amount: 40, currency: 'CAD', pending: false, accountRole: 'household-cash',
      atlasAccountId: 'chequing-a', payee: 'Invented bill' }] };
  const a = alloc(plan({ base: true }), live({ currentPeriodActuals: packet }));
  ok(a.currentBalancePublication.status === 'planned-dale-payday' && a.currentBalancePublication.amount === 2960,
    'householdCurrentBalance: 1,000.00 - 40.00 + 2,000.00 = 2,960.00');
  ok(a.available === 2960 && a.paydayShellTrust.available === 'estimated' && !a.paydayBalance,
    'paydayAllocation: 2,960.00, estimated, from that base (not 5,000.00)', JSON.stringify([a.available, a.paydayShellTrust.available]));
  const unqualified = alloc(plan({ base: true }), live({ currentPeriodActuals: packet, observedCash: observed(2999.99) }));
  ok(withheld(unqualified), 'the same base beside an unqualified observed row still withholds');
}

console.log('6. Downstream: no $0.00 leftover, and the assistant packet reads unavailable');
{
  const r = F.recommend(plan(), P, { weeklyVariable: 0, debts: [], ...live() });
  ok(['currentBalance', 'afterBills', 'afterHouseholdBudget', 'afterDebtRepayment', 'afterBigPurchases']
    .every(k => r.defaultView[k] === null), 'the default view\'s running leftover is null, never $0.00',
    JSON.stringify(['currentBalance', 'afterBills'].map(k => r.defaultView[k])));
  const packet = A.buildPacket({ data: { meta: { asOf: P }, plan: plan(), debts: [],
    liveOverlay: { operatingPlan: 'live', observedCash: observed() } }, periods: { periods: {} }, questionsMarkdown: '', env: {},
    now: P + 'T19:00:00Z' });
  const pa = packet.forecast.paydayAllocation;
  ok(pa && pa.status === 'unavailable' && !pa.runningLeftover, 'packet: paydayAllocation unavailable', JSON.stringify(pa));
}

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) process.exit(1);
