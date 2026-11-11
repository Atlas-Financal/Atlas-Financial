'use strict';
/* #723: an income override must be a real number. Text, empty or true never
 * becomes income and never publishes as zero; it withholds as Unknown.
 *
 * Invented plan: as-of Wed 2026-10-14, biweekly pay 1,400 anchored Fri
 * 2026-10-09 (This Pay Period Oct 9 - Oct 22, Next Oct 23 - Nov 5), one
 * monthly bill of 90 on the 12th (lands only in This Pay Period).
 *
 * Hand-worked expectations (from the inputs, not from Atlas):
 *   no override:       income 1,400 each period; after bills 1,310 / 1,400.
 *   override 2,500:    a monthly figure paid bi-weekly is 26ths of a year:
 *                      2,500 x 12 / 26 = 1,153.846... -> 1,153.85 each
 *                      period; after bills 1,153.85 - 90 = 1,063.85 / 1,153.85.
 *   override 0:        income 0; after bills -90 / 0 (a declared zero stays).
 *   "2500", "", " ", true, false, [], NaN, Infinity: income and after bills
 *                      are unknown (null) in both periods.
 *   null / no entry:   no override (same as none).
 *
 * `node test/test-income-override-numeric.js`
 */
const F = require('../public/forecast.js');
let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures += 1;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' - ' + detail : ''}`);
};
const AS_OF = '2026-10-14';
const plan = () => ({
  defaults: { targetBuffer: 0 }, startingCash: { amount: 2000 },
  opening: { asOf: AS_OF, priorAsOf: '2026-10-09', representedEvents: [] },
  income: [{ id: 'payroll', label: 'Invented pay', frequency: 'biweekly', anchor: '2026-10-09', amount: 1400, confidence: 'confirmed' }],
  bills: [{ id: 'hydro', label: 'Invented hydro', frequency: 'monthly', day: 12, amount: 90, confidence: 'confirmed' }],
  obligations: [], commitments: [], budget: { categories: [] },
});
const periods = override => {
  const opts = { targetBuffer: 0, debts: [] };
  if (override !== undefined) opts.incomeOverrides = { payroll: override };
  const v = F.recommend(plan(), AS_OF, opts).defaultView;
  const by = id => v.calendarPeriods.find(x => x.id === id);
  return { cur: by('this-pay-period'), next: by('next-pay-period'), v };
};
const none = periods();
ok(none.cur.incomeTotal === 1400 && none.cur.afterBills === 1310 && none.next.afterBills === 1400,
  'no override: income 1,400, after bills 1,310 / 1,400');
for (const [label, value] of [['undefined entry', undefined], ['null', null]]) {
  const r = periods(value);
  ok(JSON.stringify(r.v) === JSON.stringify(none.v), `${label} is no override: figures identical to none`);
}
const num = periods(2500);
ok(num.cur.incomeTotal === 1153.85 && num.cur.afterBills === 1063.85 && num.next.afterBills === 1153.85,
  'number 2500: 2,500 x 12 / 26 = 1,153.85 income; after bills 1,063.85 / 1,153.85');
const zero = periods(0);
ok(zero.cur.incomeTotal === 0 && zero.cur.afterBills === -90 && zero.next.afterBills === 0,
  'number 0 stays a declared zero: income 0, after bills -90 / 0');
const neg = periods(-100);
ok(neg.cur.incomeTotal === null && neg.cur.afterBills === null,
  'number -100 is unchanged from before: not a valid income, so unknown');
for (const [label, value] of [['text "2500"', '2500'], ['empty ""', ''], ['blank " "', ' '],
  ['true', true], ['false', false], ['array []', []], ['NaN', NaN], ['Infinity', Infinity]]) {
  const r = periods(value);
  ok(r.cur.incomeTotal === null && r.cur.afterBills === null && r.next.incomeTotal === null && r.next.afterBills === null,
    `${label} withholds income and after bills as unknown (never income, never zero)`,
    `income=${r.cur.incomeTotal} after=${r.cur.afterBills}`);
}

/* ---- Decision surfaces: an invalid override is unknown, never a $0 income.
 * Invented world: payroll 1,400 biweekly from 2026-12-04, rent 900 a month,
 * an invented 9,000 roof (2027-05-20) and 6,000 flexible car (2027-03-10),
 * opening cash 3,000, as-of 2026-12-31, with and without a 2027 payroll
 * regime. Hand-worked controls: a DECLARED override of 0 is a real zero
 * income (the car and roof read FUNDING GAP, free cash is negative); no
 * override leaves the car ON TRACK. An invalid override must be neither: the
 * walk, free cash, plan-spend funding and both major-plan verdicts are
 * withheld (null / unavailable), never a verdict that treats income as 0. */
const SIM_AS_OF = '2026-12-31';
const simWorld = regime => {
  const p = {
    defaults: { targetBuffer: 200, extraDebtMonthly: 0, scenario: 'expected' }, windowDays: 91,
    startingCash: { breakdown: [{ id: 'chequing-a', label: 'BILLS ACCOUNT', value: 3000, class: 'spendable' }] },
    opening: { asOf: SIM_AS_OF },
    budget: { categories: [{ id: 'groceries', label: 'Groceries', class: 'essential', from: ['Groceries'], plannedWeekly: 100 }] },
    obligations: [],
    bills: [{ id: 'rent', label: 'Rent', frequency: 'monthly', day: 5, amount: 900, confidence: 'confirmed', payingAccount: 'chequing-a' }],
    commitments: [
      { id: 'roof', label: 'Invented roof', date: '2027-05-20', amount: 9000, confidence: 'confirmed' },
      { id: 'car', label: 'Invented car', date: '2027-03-10', amount: 6000, confidence: 'estimated', flexibility: 'flexible' }],
    income: [{ id: 'payroll', label: 'Invented pay', frequency: 'biweekly', anchor: '2026-12-04', amount: 1400,
      scenarioMonthly: { expected: 3033 }, confidence: 'confirmed' }],
  };
  if (regime) p.payrollPlanningAssumptions = { salaryRaiseFactor: 1, bonusRate: 0, authorizedThroughYear: 2027 };
  return p;
};
const surfaces = (regime, override) => {
  const opts = { targetBuffer: 200, debts: [], scenario: 'expected' };
  if (override !== undefined) opts.incomeOverrides = { payroll: override };
  const p = simWorld(regime);
  const r = F.recommend(p, SIM_AS_OF, opts);
  const sim = F.simulate(p, SIM_AS_OF, { ...opts, weeklyVariable: 100 });
  const state = F.scheduledAmountState(p, SIM_AS_OF, '2027-12-31', opts);
  const verdict = id => ((r.majorPlans || []).find(m => m.id === id) || {}).verdict;
  return { r, sim, state, car: verdict('car'), roof: verdict('roof'),
    funding: r.planSpendPaydayFunding && r.planSpendPaydayFunding.status,
    free: r.knowledge && r.knowledge.freeCash };
};
for (const regime of [false, true]) {
  const tag = regime ? 'with payroll regime' : 'no regime';
  const none = surfaces(regime);
  ok(none.state.status === 'ready' && none.car === 'ON TRACK' && none.free > 0,
    `${tag}: no override is unchanged (state ready, car ON TRACK, free cash positive)`);
  const zero = surfaces(regime, 0);
  ok(zero.state.status === 'ready' && zero.car === 'FUNDING GAP' && zero.free < 0,
    `${tag}: a declared 0 stays a real zero income (FUNDING GAP, negative free cash)`);
  for (const [label, value] of [['text "2000"', '2000'], ['empty ""', ''], ['true', true], ['NaN', NaN], ['Infinity', Infinity]]) {
    const x = surfaces(regime, value);
    ok(x.state.status === 'unavailable' && x.state.unknowns.some(u => u.carrier === 'income' && u.id === 'payroll'),
      `${tag}, ${label}: the scheduled-amount state is unavailable and names the income`);
    ok(x.sim.status === 'unavailable' && x.sim.totals.income === null && x.sim.ending === null
      && x.sim.min && x.sim.min.balance === null,
      `${tag}, ${label}: the simulation withholds income, ending and minimum (not a zero-income walk)`,
      `status=${x.sim.status} ending=${x.sim.ending}`);
    ok(x.car === null && x.roof === null,
      `${tag}, ${label}: both major-plan verdicts are withheld, no FUNDING GAP and no ON TRACK`,
      `car=${x.car} roof=${x.roof}`);
    ok(x.funding === 'unavailable' && x.free === null,
      `${tag}, ${label}: plan-spend funding is unavailable and free cash is null, not a gap`,
      `funding=${x.funding} free=${x.free}`);
  }
}

/* ---- Income deadlines: an invalid override is an unknown income, not a zero
 * one that answers "no deadline". Hand-worked controls on the same invented
 * world: a valid override of 0 is a real zero (amount 0, no breach), no
 * override has a real positive amount, and an invalid override is unavailable. */
{
  const deadlineWorld = () => {
    const p = simWorld(false);
    p.income = [{ id: 'amandaSalary', label: 'Invented Amanda pay', frequency: 'biweekly', anchor: '2026-12-04', amount: 1400, confidence: 'confirmed' }];
    return p;
  };
  const dl = override => F.incomeDeadline(deadlineWorld(), SIM_AS_OF, 'amandaSalary',
    { targetBuffer: 200, debts: [], incomeOverrides: override === undefined ? undefined : { amandaSalary: override } });
  const hh = override => F.amandaHouseholdIncomeDeadline(deadlineWorld(), SIM_AS_OF,
    { targetBuffer: 200, debts: [], incomeOverrides: override === undefined ? undefined : { amandaSalary: override } });
  ok(dl().amount === 1400 && dl().status === undefined, 'incomeDeadline control: no override keeps its real 1,400 amount');
  ok(dl(0).amount === 0 && dl(0).breachesWithout === false, 'incomeDeadline control: a declared 0 is a real zero');
  ok(hh().amount > 0, 'household deadline control: no override has a positive amount');
  for (const [label, value] of [['text "2000"', '2000'], ['empty ""', ''], ['true', true], ['NaN', NaN]]) {
    const a = dl(value), b = hh(value);
    ok(a.status === 'unavailable' && a.amount === null && a.breachesWithout === null && a.neededBy === null,
      `incomeDeadline, ${label}: unavailable, not "no deadline"`, JSON.stringify(a));
    ok(b.status === 'unavailable' && b.amount === null && b.breachesWithout === null,
      `amandaHouseholdIncomeDeadline, ${label}: unavailable, not a zero or smaller sum`, JSON.stringify(b));
  }
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
