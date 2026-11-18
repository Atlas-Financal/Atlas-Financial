'use strict';
/* PR B2 of "budget amounts come from Lunch Money budgets" (owner decision,
 * #821, 2026-11-18; lead rulings C2-C5). Forecast turns each resolved budget
 * row's Lunch Money budget periods (packet lunchMoneyBudgets.byRow) into dated
 * plan targets, and every reader picks them up:
 *   C3  a pay period uses the Lunch Money period containing its start;
 *   C2  a payday row holds monthly x 14 / (365.25 / 12); a
 *       first-seaspan-of-month row holds the full monthly on its ON payday;
 *       a monthly row's target is the monthly budget (C5: a row with no plan
 *       target today gains one);
 *   Q2  a period with no budget set carries the last set budget forward,
 *       tagged estimated with a reason, and so does every date after the
 *       last period read;
 *   C4  a row Lunch Money does not resolve, a row with no budget ever set,
 *       and any date before the first set budget keep the plan target,
 *       tagged as before.
 *
 * Invented data only. Expected amounts are computed here from the ruling's
 * arithmetic, never by reading Forecast back to itself.
 *
 * `node test/test-lunchmoney-budget-targets.js`
 */
const F = require('../public/forecast.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const near = (a, b) => a != null && b != null && Math.abs(Number(a) - Number(b)) < 0.005;
const cent = n => Math.round(n * 100) / 100;
const MONTH_DAYS = 365.25 / 12;
const paydayOf = monthly => cent(monthly * 14 / MONTH_DAYS);

// Invented plan: a Seaspan-style biweekly payroll from Fri 2026-10-09, so
// pay periods start Oct 9, Oct 23, Nov 6, Nov 20, Dec 4, ...
function invented() {
  return {
    windowDays: 91, defaults: { targetBuffer: 0 },
    startingCash: { breakdown: [{ id: 'chequing-a', label: 'BILLS ACCOUNT', value: 8000 }] },
    opening: { asOf: '2026-10-09' },
    income: [{ id: 'payroll', label: 'Payroll — Seaspan', frequency: 'biweekly', anchor: '2026-10-09',
      amount: 4000, confidence: 'confirmed' }],
    bills: [], commitments: [], obligations: [],
    budget: { categories: [
      { id: 'groceries', label: 'Groceries', class: 'essential', from: ['Groceries'], plannedPayday: 900, plannedMonthly: null },
      { id: 'pets', label: 'Pets', class: 'essential', from: ['Pets'], plannedPayday: 100, plannedMonthly: null,
        paydayCadence: 'first-seaspan-of-month' },
      { id: 'restaurants', label: 'Restaurants', class: 'discretionary', from: ['Restaurants'], plannedPayday: 200, plannedMonthly: null },
      { id: 'household', label: 'Household', class: 'essential', from: ['Home'], plannedMonthly: 0 },
      { id: 'dale-guilt-free', label: 'Dale', class: 'discretionary', from: ['Dale'], plannedPayday: 150, plannedMonthly: null },
    ] },
  };
}
const P = (start, end, budgeted) => ({ start, end, budgeted, level: budgeted == null ? null : 'group' });
const OCT = ['2026-10-01', '2026-10-31'], NOV = ['2026-11-01', '2026-11-30'], DEC = ['2026-12-01', '2026-12-31'];
const BLOCK = { source: 'provider-observe:lunchmoney', status: 'read', granularity: 'month', quantity: 1, anchorDate: '2026-01-01',
  byRow: {
    // Oct 1950, Nov not set (carried: 1950, estimated), Dec 2100.
    groceries: { status: 'read', periods: [P(...OCT, 1950), P(...NOV, null), P(...DEC, 2100)] },
    pets: { status: 'read', periods: [P(...OCT, 120), P(...NOV, 120), P(...DEC, 130)] },
    // Lunch Money does not resolve this row: the plan's 200 stays.
    restaurants: { status: 'unavailable', reason: 'group-id-missing' },
    // C5 shape: a monthly row (plan baseline 0) gains a 300 target.
    household: { status: 'read', periods: [P(...OCT, 300), P(...NOV, 300), P(...DEC, 300)] },
    // Resolved, but no budget ever set: the plan's 150 stays (C4).
    'dale-guilt-free': { status: 'read', periods: [P(...OCT, null), P(...NOV, null), P(...DEC, null)] },
  } };

function periods(plan, asOf) {
  const advice = F.recommend(plan, asOf, { targetBuffer: 0, debts: [] });
  return (advice.defaultView && advice.defaultView.calendarPeriods) || [];
}
const row = (period, id) => ((period && period.householdBudget) || []).find(r => r && r.id === id) || null;

console.log('1. Pay periods use the Lunch Money period containing their start (C2, C3)');
{
  const plan = F.withLunchMoneyBudgets(invented(), BLOCK, '2026-10-09');
  const [oct9, oct23] = periods(plan, '2026-10-09');
  ok(oct9 && oct9.start === '2026-10-09' && oct23 && oct23.start === '2026-10-23', 'periods start Oct 9 and Oct 23');
  // Oct 23 - Nov 5 starts in October: October's budget, though most of it is November.
  for (const [p, label] of [[oct9, 'Oct 9'], [oct23, 'Oct 23']]) {
    ok(near(row(p, 'groceries').planned, paydayOf(1950)), `${label}: groceries holds 1950 x 14 / 30.4375 = ${paydayOf(1950)}`,
      String(row(p, 'groceries').planned));
    ok(near(row(p, 'household').planned, paydayOf(300)), `${label}: household (monthly row, plan 0) holds 300 x 14 / 30.4375 = ${paydayOf(300)}`,
      String(row(p, 'household') && row(p, 'household').planned));
    ok(!row(p, 'groceries').trust && !row(p, 'household').trust, `${label}: a set budget carries no estimate tag`);
  }
  ok(near(row(oct9, 'pets').planned, 120), 'Oct 9 (first payday of October): pets holds the full 120');
  ok(near(row(oct23, 'pets').planned, 0), 'Oct 23: pets holds nothing (not the first payday of the month)');
  ok(near(row(oct9, 'restaurants').planned, 200) && !row(oct9, 'restaurants').trust,
    'restaurants (not resolved) keeps its plan 200, untagged as before');
  ok(near(row(oct9, 'dale-guilt-free').planned, 150) && !row(oct9, 'dale-guilt-free').trust,
    'dale-guilt-free (no budget ever set) keeps its plan 150, untagged as before (C4)');
}

console.log('2. A month with no budget set carries the last one forward, estimated with a reason (Q2)');
{
  const plan = F.withLunchMoneyBudgets(invented(), BLOCK, '2026-11-06');
  const [nov6, nov20] = periods(plan, '2026-11-06');
  for (const [p, label] of [[nov6, 'Nov 6'], [nov20, 'Nov 20']]) {
    const g = row(p, 'groceries');
    ok(near(g.planned, paydayOf(1950)) && g.trust === 'estimated' && g.estimateReason === 'lunch-money-budget-carried-forward',
      `${label}: groceries carries October's 1950 (${paydayOf(1950)}), estimated, lunch-money-budget-carried-forward`,
      JSON.stringify({ planned: g.planned, trust: g.trust, reason: g.estimateReason }));
    ok(p.budgetHoldTrust === 'estimated', `${label}: the period's household hold is tagged estimated`, String(p.budgetHoldTrust));
  }
  ok(near(row(nov6, 'pets').planned, 120) && !row(nov6, 'pets').trust, 'Nov 6: pets reads November\'s own 120, untagged');
}

console.log('3. After the last period read, the last budget carries forward, estimated');
{
  const plan = F.withLunchMoneyBudgets(invented(), BLOCK, '2027-01-01');
  const [jan1] = periods(plan, '2027-01-01');
  const g = row(jan1, 'groceries');
  ok(near(g.planned, paydayOf(2100)) && g.trust === 'estimated', `Jan 1 2027: groceries carries December's 2100 (${paydayOf(2100)}), estimated`,
    JSON.stringify({ planned: g.planned, trust: g.trust }));
  ok(near(row(jan1, 'pets').planned, 130) && row(jan1, 'pets').trust === 'estimated', 'Jan 1 2027: pets carries 130, estimated');
}

console.log('4. Before the first budget read, the plan target applies');
{
  const plan = F.withLunchMoneyBudgets(invented(), BLOCK, '2026-09-25');
  const [sep25] = periods(plan, '2026-09-25');
  ok(sep25 && sep25.start === '2026-09-25' && near(row(sep25, 'groceries').planned, 900) && !row(sep25, 'groceries').trust,
    'Sep 25 (before October): groceries keeps the plan 900, untagged', String(sep25 && row(sep25, 'groceries').planned));
  ok(!row(sep25, 'household'), 'Sep 25: household keeps its plan 0 baseline (no hold row)');
}

console.log('5. Nothing to apply leaves the plan exactly as it was');
{
  const base = invented();
  const before = JSON.stringify(base);
  F.withLunchMoneyBudgets(base, BLOCK, '2026-10-09');
  ok(JSON.stringify(base) === before, 'the input plan is never mutated');
  ok(F.withLunchMoneyBudgets(base, null, '2026-10-09') === base, 'no budget block: the same plan');
  ok(F.withLunchMoneyBudgets(base, { source: 'provider-observe:lunchmoney', status: 'unavailable', reason: 'budget-read-failed' }, '2026-10-09') === base,
    'an unavailable budget read: the same plan');
  ok(F.withLunchMoneyBudgets(base, { ...BLOCK, granularity: 'week' }, '2026-10-09') === base,
    'weekly Lunch Money periods do not convert: the same plan');
  ok(F.withLunchMoneyBudgets(base, { ...BLOCK, quantity: 2 }, '2026-10-09') === base,
    'two-month Lunch Money periods do not convert: the same plan');
  const onlyUnresolved = { ...BLOCK, byRow: { restaurants: BLOCK.byRow.restaurants, 'dale-guilt-free': BLOCK.byRow['dale-guilt-free'] } };
  ok(F.withLunchMoneyBudgets(base, onlyUnresolved, '2026-10-09') === base,
    'only unresolved or never-set rows: the same plan');
  const a = JSON.stringify(periods(base, '2026-10-09'));
  const b = JSON.stringify(periods(F.withLunchMoneyBudgets(base, onlyUnresolved, '2026-10-09'), '2026-10-09'));
  ok(a === b, 'and so every published period is identical');
}

console.log('6. An invalid plan target is not replaced by a Lunch Money budget');
{
  const base = invented();
  base.budget.categories[0].plannedPayday = 'tbd';
  const plan = F.withLunchMoneyBudgets(base, BLOCK, '2026-10-09');
  ok(plan.budget.categories[0] === base.budget.categories[0], 'the invalid row is left for the plan-input check');
}

console.log('7. Wired through the live plan: the served plan carries the targets, live and replay alike');
{
  const H = require('./acceptance/harness.js');
  const Live = require('../scripts/live-plan');
  const Memory = require('../scripts/server-observation-memory.js');
  // Invented catalog and raw budget read: group 9100 holds the groceries
  // budget (Oct 1950, Nov 2000).
  const categories = [{ id: 9100, name: 'Invented food group', is_group: true, children: [{ id: 201, name: 'Invented a' }] },
    { id: 108, name: 'Payroll', is_income: true }];
  const raw = { status: 'read',
    settings: { budget_period_granularity: 'month', budget_period_quantity: 1, budget_period_anchor_date: '2026-01-01' },
    summary: { categories: [{ category_id: 9100, occurrences: [
      { start_date: '2026-10-01', end_date: '2026-10-31', budgeted: 1950 },
      { start_date: '2026-11-01', end_date: '2026-11-30', budgeted: 2000 }] }] } };
  const w = H.baseWorld();
  w.transactions = [H.lm({ id: 610001, date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  H.productionOpening(w);
  const payloadWith = budgets => ({ fetchedAt: '2026-10-09T18:00:00.000Z', ...H.rawPayload(w), categories,
    ...(budgets ? { lunchMoneyBudgets: budgets } : {}) });
  const servedFrom = payload => {
    const data = H.canonicalOf(w, H.planOf(w));
    for (const cat of data.plan.budget.categories) {
      delete cat.lunchMoneyCategoryGroupId;
      if (cat.id === 'groceries') cat.lunchMoneyCategoryGroupId = 9100;
    }
    return Live.fromObservation({ data, payload, accountMap: H.accountMapOf(w), identity: H.identityOf(w) }).data;
  };
  const served = budgets => servedFrom(payloadWith(budgets));
  const live = served(raw);
  const g = live.plan.budget.categories.find(c => c.id === 'groceries');
  ok(g && Array.isArray(g.lunchMoneyTargets) && near(g.lunchMoneyTargets[0].plannedPayday, paydayOf(1950))
    && near(g.lunchMoneyTargets[1].plannedPayday, paydayOf(2000)),
    `the served plan's groceries targets are ${paydayOf(1950)} (Oct) and ${paydayOf(2000)} (Nov)`,
    JSON.stringify(g && g.lunchMoneyTargets && g.lunchMoneyTargets.map(t => [t.from, t.plannedPayday, t.carried])));
  // The memory replay copy of this observation's budget read and catalog,
  // served in place of the live ones.
  const replay = Memory.sourceInputs({ provider: 'lunchmoney', fetchedAt: '2026-10-09T18:00:00.000Z',
    accounts: [], categories, tags: [], transactions: [],
    transactionWindow: { startDate: '2026-09-01', endDate: '2026-10-14', complete: true, hasMore: false, truncated: false },
    pendingCoverage: { basis: 'is_pending-unbounded', complete: true, hasMore: false, truncated: false },
    lunchMoneyBudgets: raw });
  const replayed = servedFrom({ ...payloadWith(null), categories: replay.categories, lunchMoneyBudgets: replay.lunchMoneyBudgets });
  ok(JSON.stringify(replayed.plan) === JSON.stringify(live.plan), 'a replayed observation serves the identical plan');
  const without = served(null);
  const plain = without.plan.budget.categories.find(c => c.id === 'groceries');
  ok(plain && !plain.lunchMoneyTargets, 'with no budget read, the served plan is the plan as before');
  const other = live.plan.budget.categories.filter(c => c.id !== 'groceries');
  ok(JSON.stringify(other) === JSON.stringify(without.plan.budget.categories.filter(c => c.id !== 'groceries')),
    'every other row is untouched');
}

console.log('8. The essential cash reserve uses the same cycle-start budget as the Budget period (Codex P1)');
{
  // Household (a monthly row) is budgeted 300 in October and 600 in
  // November. On Nov 2 the pay period started Oct 23, so the Budget period
  // prints October's 300 and the reserve must use it too. Proof without
  // reading Forecast's arithmetic back: the reserve equals the reserve of a
  // plan whose November budget is also 300.
  const base = invented();
  base.budget.categories = base.budget.categories.filter(c => c.id === 'household');
  const block = nov => ({ ...BLOCK, byRow: { household: { status: 'read', periods: [P(...OCT, 300), P(...NOV, nov)] } } });
  const reserve = nov => {
    const alloc = F.paydayAllocation(F.withLunchMoneyBudgets(base, block(nov), '2026-11-02'), '2026-11-02', {});
    const item = ((alloc.essentials && alloc.essentials.items) || []).find(i => i.id === 'household');
    return item ? item.required : null;
  };
  const changed = reserve(600), flat = reserve(300);
  ok(changed != null && near(changed, flat), 'a November budget change does not move the reserve of a cycle that started in October',
    `${changed} vs ${flat}`);
  const [oct23] = periods(F.withLunchMoneyBudgets(base, block(600), '2026-11-02'), '2026-11-02');
  ok(oct23 && oct23.start === '2026-10-23' && near(row(oct23, 'household').planned, paydayOf(300)),
    `and the Budget period prints October's ${paydayOf(300)}`, String(oct23 && row(oct23, 'household').planned));
}

console.log('9. A carried budget with a possible-duplicate Spent keeps both estimates (Codex P2)');
{
  const H = require('./acceptance/harness.js');
  // Invented look-alike pair (the test-pending-lookalike setup): a pending
  // and a posted 6.50 cafe purchase with different authorizations.
  const cafe = { date: '2026-10-11', amount: 6.5, category: 'Restaurants', payee: 'Invented cafe' };
  const w = H.baseWorld();
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' }),
    H.lm({ ...cafe, originalName: 'INVENTED-CAFE', raw: { plaid_metadata: { transaction_id: 'invented-cafe-posting',
      pending_transaction_id: 'invented-cafe-replaced-auth' } } }),
    H.lm({ ...cafe, pending: true, raw: { plaid_metadata: { transaction_id: 'invented-cafe-visible-auth' } } })];
  const { data, packet } = H.dataOf(w);
  // Restaurants: September budget 300, October not set, so October carries 300.
  const block = { ...BLOCK, byRow: { restaurants: { status: 'read', periods: [P('2026-09-01', '2026-09-30', 300), P(...OCT, null)] } } };
  const view = F.recommend(F.withLunchMoneyBudgets(data.plan, block, data.meta.asOf), data.meta.asOf,
    { currentPeriodActuals: packet, debts: data.debts }).defaultView;
  const period = (view.calendarPeriods || []).find(p => p.id === 'this-pay-period');
  const eating = row(period, 'restaurants');
  ok(eating && near(eating.planned, paydayOf(300)) && near(eating.spent, 13),
    `positive control: restaurants carries ${paydayOf(300)} and spent 13 (two possible duplicates)`, JSON.stringify(eating && [eating.planned, eating.spent]));
  ok(eating && eating.trust === 'estimated' && eating.plannedTrust === 'estimated' && eating.spentTrust === 'estimated'
    && eating.estimateReason === 'lunch-money-budget-carried-forward',
    'the plan stays estimated (never calculated), Spent is estimated, and the carry-forward reason is kept',
    JSON.stringify(eating && { trust: eating.trust, plannedTrust: eating.plannedTrust, spentTrust: eating.spentTrust, reason: eating.estimateReason }));
  // Without the carry, the incumbent possible-duplicate tag is unchanged.
  const plainView = F.recommend(data.plan, data.meta.asOf, { currentPeriodActuals: packet, debts: data.debts }).defaultView;
  const plain = row((plainView.calendarPeriods || []).find(p => p.id === 'this-pay-period'), 'restaurants');
  ok(plain && plain.plannedTrust === 'calculated' && plain.estimateReason === 'possible-duplicate' && plain.spentTrust === undefined,
    'without a carried budget the possible-duplicate tag is exactly as before', JSON.stringify(plain && [plain.plannedTrust, plain.estimateReason]));
}

console.log(failures ? `\n${failures} failure(s)` : '\nall cases pass');
process.exit(failures ? 1 : 0);
