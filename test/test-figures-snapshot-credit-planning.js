'use strict';
/* B100 — figures-snapshot covers Credit and Planning published figures.
 * `node test/test-figures-snapshot-credit-planning.js`
 *
 * The snapshot copies Forecast.creditAccounts and the same Forecast.recommend
 * majorPlans / paydayAllocation / knowledge the pages render. It does not
 * recompute headroom, minimums, verdicts, or range midpoints. Plan-page keys
 * that already existed on main stay present and unchanged.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const F = require('../public/forecast.js');
const { buildFiguresSnapshot } = require('../scripts/figures-snapshot.js');
const { sourceText } = require('./test-source-text');

const ROOT = path.join(__dirname, '..');
const MAIN = 'origin/main';
// PR #264's before/after absence proof needs its immutable pre-change source;
// current main contains the new keys as soon as that PR is merged.
const BEFORE_HOUSEHOLD_BUDGET_TOTAL = '6626b39fd5ce8416659ee93f2ead9a85084de7ba';
const read = file => sourceText(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const live = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));
const periods = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/periods.json'), 'utf8'));

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const round = n => n == null ? null : Math.round(Number(n) * 100) / 100;
const same = (a, b) => {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 0.005;
  return a === b;
};

const PLAN_PREFIX = /^(meta|cash|plan|payday|operating|totals|budget|scoreboard|debt|balance|heloc|action|policy)\./;
const PLAN_KEYS_ON_MAIN = [
  'meta.asOf', 'meta.windowDays', 'meta.targetBuffer', 'meta.scenario',
  'cash.spendableToday', 'cash.elsewhere.operational', 'cash.elsewhere.purpose-reserve',
  'cash.elsewhere.other-liquid', 'plan.mode', 'plan.weeklyCap', 'plan.weeklyCapMonthly',
  'plan.effectiveFrom', 'plan.bindingDate', 'plan.bindingBalance', 'plan.endingCash',
  'plan.lowestCash', 'plan.lowestCashDate', 'payday.available', 'payday.obligations',
  'payday.essentials', 'payday.liquidity', 'payday.futureCosts', 'payday.extraDebt',
  'payday.unallocated', 'payday.riskShortfall', 'operating.this.start',
  'operating.this.end', 'operating.this.opening', 'operating.this.available',
  'operating.this.incomeAdded',
  'operating.this.otherIncome',
  'operating.this.incomeTotal',
  'operating.this.projectedEnding',
  'operating.this.householdBudgetTotal', 'operating.liveCurrentBalance',
  'operating.next.start', 'operating.next.end',
  'operating.next.available', 'operating.next.incomeAdded',
  'operating.next.otherIncome', 'operating.next.incomeTotal',
  'operating.next.projectedEnding',
  'operating.next.householdBudgetTotal', 'totals.confirmedIncome', 'totals.estimatedIncome',
  'totals.obligations', 'totals.bills', 'totals.commitments', 'totals.nonCashInterest',
  'budget.basis', 'budget.essentialPerMonth', 'budget.requiredPerMonth',
  'budget.requiredPerWeek', 'budget.discretionaryPerMonth', 'budget.reservePerMonth',
  'budget.datedPerMonth', 'budget.foodAndFuelPerMonth', 'budget.foodAndFuelPerWeek',
  'scoreboard.today.cash', 'scoreboard.today.consumerDebt', 'scoreboard.today.heloc',
  'scoreboard.today.creditHeadroom', 'scoreboard.today.facilitiesOverLimit',
  'scoreboard.day30.cash', 'scoreboard.day30.consumerDebt', 'scoreboard.day30.heloc',
  'scoreboard.day30.creditHeadroom', 'scoreboard.day30.facilitiesOverLimit',
  'scoreboard.day60.cash', 'scoreboard.day60.consumerDebt', 'scoreboard.day60.heloc',
  'scoreboard.day60.creditHeadroom', 'scoreboard.day60.facilitiesOverLimit',
  'scoreboard.day90.cash', 'scoreboard.day90.consumerDebt', 'scoreboard.day90.heloc',
  'scoreboard.day90.creditHeadroom', 'scoreboard.day90.facilitiesOverLimit',
  'debt.interestOverWindow',   'debt.overLimit.triangle', 'debt.overLimit.travelvisa', 'balance.assets', 'balance.debts',
  'balance.consumerDebtPosted', 'balance.consumerDebtPending',
  'balance.consumerDebtEffective', 'balance.securedDebt', 'heloc.vsLastMonth',
  'heloc.vsLastMonthVerdict', 'heloc.currentOpening', 'action.next',
  'action.nextAmount', 'action.nextDue', 'action.openCount', 'policy.nextDollarTarget',
];

/* ---------------------------------------------------------------- fixtures */
const CREDIT_AS_OF = '2026-03-10';
function creditFixture() {
  return {
    meta: { asOf: CREDIT_AS_OF },
    revolvingExtra: [],
    debts: [
      { id: 'card-a', label: 'Card A', secured: false, balance: 4200.10, pending: 300.55, pendingUnknown: false,
        limit: 5000, rate: 21.99, payment: 120, frequency: 'Monthly minimum', confidence: 'verified' },
      { id: 'card-b', label: 'Card B', secured: false, balance: 500, pendingUnknown: true,
        limit: 2000, rate: 19.99, payment: 25, frequency: 'Monthly minimum', confidence: 'verified' },
      { id: 'card-over', label: 'Card Over', secured: false, balance: 1050, pending: 0, pendingUnknown: false,
        limit: 1000, rate: 24.99, payment: 10, frequency: 'Monthly minimum', confidence: 'verified' },
      { id: 'heloc', label: 'HELOC', secured: true, balance: 90000, pending: 0, limit: 100000, rate: 4.9,
        payment: 400, interestTreatment: 'capitalised', cashPayment: 0, monthlyInterest: 400,
        confidence: 'verified' },
      { id: 'mortgage', label: 'Mortgage', secured: true, balance: 500000, pending: 0, limit: null, rate: 3.64,
        payment: 1600, frequency: 'Bi-weekly', confidence: 'verified' },
    ],
    plan: {
      windowDays: 91,
      defaults: { scenario: 'expected', targetBuffer: 0, extraDebtMonthly: 0 },
      opening: { asOf: CREDIT_AS_OF },
      startingCash: { breakdown: [{ id: 'chequing-a', label: 'Chequing A', value: 5000 }] },
      income: [{ id: 'pay', label: 'Pay', frequency: 'biweekly', anchor: '2026-03-06', amount: 2000, confidence: 'confirmed' }],
      obligations: [
        { id: 'mortgage', debtId: 'mortgage', effect: 'payment', label: 'Mortgage', frequency: 'biweekly',
          anchor: '2026-03-06', amount: 1600, confidence: 'confirmed', payingAccount: 'chequing-a' },
        { id: 'heloc', debtId: 'heloc', effect: 'capitalise', label: 'HELOC interest', frequency: 'monthly', day: 31,
          amount: 400, confidence: 'confirmed', nonCash: true, payingAccount: 'chequing-a',
          cashPayment: 400, cashDay: 21, cashFirstDue: '2026-03-21', cashLabel: 'HELOC minimum', cashConfidence: 'estimated' },
        { id: 'card-a', debtId: 'card-a', effect: 'payment', label: 'Card A minimum', frequency: 'monthly', day: 15,
          amount: 120, confidence: 'estimated', payingAccount: 'chequing-a' },
        { id: 'card-b-mar', debtId: 'card-b', effect: 'payment', label: 'Card B — March statement minimum', frequency: 'once',
          date: '2026-03-20', amount: 25, confidence: 'confirmed', payingAccount: 'chequing-a' },
        { id: 'card-over', debtId: 'card-over', effect: 'payment', label: 'Card Over minimum', frequency: 'monthly', day: 5,
          amount: 10, confidence: 'estimated', payingAccount: 'chequing-a' },
      ],
      bills: [],
      commitments: [],
    },
  };
}

const PLANNING_AS_OF = '2026-03-10';
function planningFixture() {
  return {
    meta: { asOf: PLANNING_AS_OF },
    revolvingExtra: [],
    debts: [],
    plan: {
      windowDays: 91,
      defaults: { scenario: 'expected', targetBuffer: 0, extraDebtMonthly: 0 },
      opening: { asOf: PLANNING_AS_OF },
      startingCash: { breakdown: [{ id: 'chequing-a', label: 'Chequing A', value: 50000 }] },
      income: [{ id: 'pay', label: 'Pay', frequency: 'biweekly', anchor: '2026-03-06', amount: 2000, confidence: 'confirmed' }],
      obligations: [],
      bills: [],
      commitments: [
        { id: 'dated-point', date: '2026-04-10', label: 'Dated point cost', amount: 800, confidence: 'estimated', adjustable: true },
        { id: 'point', label: 'Point estimate', amount: 2000, when: 'late Sep 2026', confidence: 'estimated' },
        { id: 'range', label: 'Range cost', amount: null, amountMin: 700, amountMax: 1200, when: 'Fall 2026', confidence: 'estimated', adjustable: true },
        { id: 'tbd', label: 'Timing TBD cost', amount: 1000, when: 'timing TBD', confidence: 'estimated' },
      ],
    },
  };
}

function snapshotRecommend(data) {
  return F.recommend(data.plan, data.meta.asOf, {
    scenario: data.plan.defaults.scenario, incomeOverrides: {}, disabled: [],
    extraDebtMonthly: data.plan.defaults.extraDebtMonthly || 0,
    targetBuffer: data.plan.defaults.targetBuffer,
    fundingSources: (data.plan.funding || {}).options,
    extraFacilities: data.revolvingExtra,
  });
}

function runCli(args = []) {
  return JSON.parse(execFileSync(process.execPath, [
    path.join(ROOT, 'scripts/figures-snapshot.js'), ...args,
  ], { encoding: 'utf8', cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }));
}

// The reference revision's own script on today's data.json. `--household-only`
// selects the household map from a G1-or-later script; an older script
// ignores its arguments and emits that same household map.
function runReferenceSnapshot(ref) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'figures-snapshot-main-'));
  try {
    // The reference revision's whole scripts/ tree, so its snapshot script
    // runs against its own sibling modules, never the working tree's copies.
    const archive = execFileSync('git', ['archive', '--format=tar', ref, 'scripts'], {
      cwd: ROOT, maxBuffer: 256 * 1024 * 1024,
    });
    execFileSync('tar', ['-x', '-C', tmp], { input: archive });
    fs.symlinkSync(path.join(ROOT, 'public'), path.join(tmp, 'public'),
      process.platform === 'win32' ? 'junction' : 'dir');
    fs.copyFileSync(path.join(ROOT, 'data.json'), path.join(tmp, 'data.json'));
    return JSON.parse(execFileSync(process.execPath, [
      path.join(tmp, 'scripts/figures-snapshot.js'), '--household-only',
    ], { encoding: 'utf8', cwd: tmp, maxBuffer: 64 * 1024 * 1024 }));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const snapSrc = sourceText(read('scripts/figures-snapshot.js'));
const stripComments = src => String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

console.log('=== 1. Credit published figures have stable snapshot keys ===');
{
  const fx = creditFixture();
  const snap = buildFiguresSnapshot(fx, null);
  const accounts = F.creditAccounts(fx.plan, fx.debts, CREDIT_AS_OF, {
    extraFacilities: fx.revolvingExtra,
  });
  ok(snap['credit.asOf'] === accounts.asOf, 'credit.asOf is Forecast.creditAccounts.asOf');
  const rows = [...accounts.secured, ...accounts.cards];
  ok(rows.length === 5, 'fixture has five credit accounts');
  for (const row of rows) {
    const p = `credit.${row.id}`;
    ok(same(snap[`${p}.balance`], row.balance == null ? null : round(row.balance)),
      `${row.id} balance is snapshotted`);
    ok(snap[`${p}.pendingUnknown`] === (row.pendingUnknown === true),
      `${row.id} pendingUnknown is snapshotted`);
    ok(same(snap[`${p}.pending`], row.pending),
      `${row.id} pending is Forecast.creditAccounts.pending`);
    ok(same(snap[`${p}.rate`], row.rate == null ? null : round(row.rate)),
      `${row.id} rate is snapshotted`);
    if (row.shape !== 'secured-term') {
      ok(same(snap[`${p}.limit`], row.limit == null ? null : round(row.limit)),
        `${row.id} limit is snapshotted`);
      ok(same(snap[`${p}.available`], row.available == null ? null : round(row.available)),
        `${row.id} available is Forecast.creditAccounts.available`);
      ok(snap[`${p}.overLimit`] === (row.overLimit === true),
        `${row.id} overLimit is snapshotted`);
    } else {
      ok(snap[`${p}.limit`] === undefined && snap[`${p}.available`] === undefined,
        `${row.id} term debt does not invent a limit or headroom key`);
    }
    ok(same(snap[`${p}.minimum`], row.nextPayment ? round(row.nextPayment.amount) : null),
      `${row.id} minimum is Forecast nextPayment.amount`);
    ok(snap[`${p}.due`] === (row.nextPayment ? row.nextPayment.date : null),
      `${row.id} due is Forecast nextPayment.date`);
  }
  const over = accounts.cards.find(r => r.id === 'card-over');
  ok(over && over.overLimit === true && same(snap['credit.card-over.overLimitBy'], round(over.overLimitBy)),
    'over-limit card snapshots Forecast overLimitBy');
  const unknown = accounts.cards.find(r => r.id === 'card-b');
  ok(unknown && unknown.pendingUnknown === true && snap['credit.card-b.pending'] == null,
    'unknown pending is copied as null, not invented as $0');
  const heloc = accounts.secured.find(r => r.id === 'heloc');
  ok(heloc && heloc.nextCapitalise
    && same(snap['credit.heloc.capitalise'], round(heloc.nextCapitalise.amount))
    && snap['credit.heloc.capitaliseDate'] === heloc.nextCapitalise.date
    && same(snap['credit.heloc.cashMinimum'], round(heloc.nextCashMinimum.amount))
    && snap['credit.heloc.cashMinimumDue'] === heloc.nextCashMinimum.date,
    'HELOC capitalise and cash minimum are Forecast occurrences');
  const mortgage = accounts.secured.find(r => r.id === 'mortgage');
  ok(mortgage && same(snap['credit.mortgage.regularPayment'], round(mortgage.regularPayment)),
    'mortgage regular payment is Forecast.creditAccounts.regularPayment');
}

console.log('\n=== 2. Planning / majorPlans published figures have stable snapshot keys ===');
{
  const fx = planningFixture();
  const snap = buildFiguresSnapshot(fx, null);
  const advice = snapshotRecommend(fx);
  ok(Array.isArray(advice.majorPlans) && advice.majorPlans.length >= 4,
    'fixture recommend returns majorPlans');
  ok(snap['planning.horizonEnd'] === advice.knowledge.end,
    'planning.horizonEnd is Forecast.knowledge.end');
  ok(same(snap['planning.encumbered'], round(advice.knowledge.encumbered)),
    'planning.encumbered is Forecast.knowledge.encumbered');
  const alloc = advice.paydayAllocation || {};
  const paydayRows = [...(alloc.futureCosts || []), ...(alloc.optional || [])];
  const unresolved = new Set((alloc.unresolved || []).map(r => r.id));
  for (const row of advice.majorPlans) {
    const p = `planning.${row.id}`;
    ok(snap[`${p}.verdict`] === row.verdict, `${row.id} verdict is Forecast.majorPlans.verdict`);
    ok(same(snap[`${p}.remaining`], round(row.remaining)),
      `${row.id} remaining is Forecast.majorPlans.remaining`);
    if (row.need != null) {
      ok(same(snap[`${p}.need`], round(row.need)), `${row.id} need is the point amount`);
      ok(snap[`${p}.amountMin`] === undefined && snap[`${p}.amountMax`] === undefined,
        `${row.id} does not invent range bounds`);
    }
    if (row.amountMin != null) ok(same(snap[`${p}.amountMin`], round(row.amountMin)), `${row.id} amountMin copied`);
    if (row.amountMax != null) ok(same(snap[`${p}.amountMax`], round(row.amountMax)), `${row.id} amountMax copied`);
    if (row.when) ok(snap[`${p}.when`] === row.when, `${row.id} when is copied verbatim`);
    if (row.date) ok(snap[`${p}.date`] === row.date, `${row.id} date is the Forecast date`);
    const payday = paydayRows.find(item => item.id === row.id);
    if (payday) {
      ok(same(snap[`${p}.allocated`], round(payday.allocated || 0)),
        `${row.id} allocated is paydayAllocation`);
      if (payday.projectedByDeadline != null) {
        ok(same(snap[`${p}.projectedByDeadline`], round(payday.projectedByDeadline)),
          `${row.id} projectedByDeadline is paydayAllocation`);
      }
    } else if (unresolved.has(row.id)) {
      ok(snap[`${p}.allocated`] === 'not-assigned',
        `${row.id} unresolved set-aside is not-assigned, not $0`);
    }
  }
  const range = advice.majorPlans.find(r => r.id === 'range');
  ok(range && range.amountMin === 700 && range.amountMax === 1200, 'range row is a range');
  ok(snap['planning.range.amountMin'] === 700 && snap['planning.range.amountMax'] === 1200,
    'range stays min/max; no midpoint key');
  ok(!Object.keys(snap).some(k => /midpoint|midRange|rangeMid/i.test(k)),
    'snapshot invents no midpoint key');
  const midpoint = (700 + 1200) / 2;
  ok(!Object.values(snap).includes(midpoint),
    'snapshot does not store the range midpoint as a value');
}

console.log('\n=== 2b. Planning trajectory published figures have stable snapshot keys ===');
{
  const snap = buildFiguresSnapshot(live, periods);
  const traj = F.baselineTrajectory(live.plan, live.debts, live.meta.asOf, {
    periods, extraFacilities: live.revolvingExtra,
  });
  ok(traj.status === 'ready', 'live baselineTrajectory is ready for snapshot');
  ok(snap['planning.trajectory.status'] === 'ready',
    'planning.trajectory.status is Forecast.baselineTrajectory.status');
  ok(snap['planning.trajectory.horizonEnd'] === traj.horizon.end,
    'planning.trajectory.horizonEnd is trajectory horizon end');
  ok(same(snap['planning.trajectory.weeklyVariable'], round(traj.weeklyVariable.amount)),
    'planning.trajectory.weeklyVariable is trajectory weeklyVariable.amount');
  for (const month of traj.months || []) {
    const p = `planning.trajectory.${month.month}`;
    ok(snap[`${p}.income.status`] === month.income.status,
      `${month.month} income.status copied`);
    ok(snap[`${p}.cash.status`] === month.cash.status,
      `${month.month} cash.status copied`);
    if (month.income.amount != null) {
      ok(same(snap[`${p}.income.amount`], round(month.income.amount)),
        `${month.month} income.amount copied when Forecast publishes one`);
    }
    if (month.cash.amount != null) {
      ok(same(snap[`${p}.cash.amount`], round(month.cash.amount)),
        `${month.month} cash.amount copied when Forecast publishes one`);
    }
    if (month.cash.asOf) {
      ok(snap[`${p}.cash.asOf`] === month.cash.asOf,
        `${month.month} cash.asOf copied for visible period-end date`);
    }
    if (month.start) ok(snap[`${p}.periodStart`] === month.start, `${month.month} periodStart copied`);
    if (month.end) ok(snap[`${p}.periodEnd`] === month.end, `${month.month} periodEnd copied`);
    if (month.income.reason) {
      ok(snap[`${p}.income.reason`] === month.income.reason,
        `${month.month} income.reason copied verbatim`);
    }
    if (month.cash.reason) {
      ok(snap[`${p}.cash.reason`] === month.cash.reason,
        `${month.month} cash.reason copied verbatim`);
    }
    if (month.debt && month.debt.status === 'calculated') {
      ok(same(snap[`${p}.debt.consumer`], round(month.debt.consumer)),
        `${month.month} debt.consumer copied`);
      if (month.debt.asOf) {
        ok(snap[`${p}.debt.asOf`] === month.debt.asOf,
          `${month.month} debt.asOf copied for visible as-of date`);
      }
    }
  }
  const jan = traj.months.find(m => m.month === '2027-01');
  ok(jan && snap['planning.trajectory.2027-01.income.status'] === 'estimated'
    && snap['planning.trajectory.2027-01.cash.status'] === 'estimated',
    '2027-01 estimated months are snapshotted, not omitted');
  ok(jan && jan.income.amount != null
    && same(snap['planning.trajectory.2027-01.income.amount'], round(jan.income.amount)),
    'estimated 2027-01 income copies Forecast amount rather than omitting it');
}

console.log('\n=== 3. Snapshot copies incumbent outputs; no second arithmetic ===');
{
  const creditBlock = snapSrc.split('Credit: Forecast.creditAccounts')[1] || '';
  const billsBlock = snapSrc.split('Bills: Forecast.householdBills')[1] || '';
  const subscriptionsBlock = snapSrc.split('Subscriptions: Forecast.householdSubscriptions')[1] || '';
  const planningBlock = snapSrc.split('Planning: Forecast.majorPlans')[1] || '';
  const trajectoryBlock = snapSrc.split('Planning trajectory: Forecast.baselineTrajectory')[1]
    || snapSrc.split('Planning trajectory:')[1] || '';
  const creditCode = stripComments(creditBlock.split('Bills: Forecast.householdBills')[0] || '');
  const billsCode = stripComments(billsBlock.split('Subscriptions: Forecast.householdSubscriptions')[0] || '');
  const subscriptionsCode = stripComments(subscriptionsBlock.split('Planning: Forecast.majorPlans')[0] || '');
  const planningCode = stripComments((planningBlock.split('Planning trajectory:')[0] || planningBlock));
  const trajectoryCode = stripComments(trajectoryBlock.split('return out;')[0] || '');
  ok(/F\.creditAccounts\(plan, data\.debts, asOf/.test(creditCode),
    'Credit keys come from Forecast.creditAccounts');
  ok(!/limit\s*[-+*/]|balance\s*[-+*/]|pending\s*[-+*/]/.test(creditCode),
    'Credit block does not recompute headroom from limit/balance/pending');
  ok(!/new Date\(|Date\.now\(/.test(creditCode),
    'Credit block does not pick a due date from the clock');
  ok(/F\.householdBills\(plan, asOf\)/.test(billsCode),
    'Bills keys come from Forecast.householdBills');
  ok(!/\*\s*26\s*\/\s*12|\/\s*3|\/\s*12/.test(billsCode),
    'Bills block does not compute a monthly equivalent');
  ok(/F\.householdSubscriptions\(plan, asOf\)/.test(subscriptionsCode),
    'Subscriptions keys come from Forecast.householdSubscriptions');
  ok(!/\*\s*26\s*\/\s*12|\/\s*3|\/\s*12/.test(subscriptionsCode),
    'Subscriptions block does not compute a monthly equivalent');
  ok(/advice\.majorPlans/.test(planningCode),
    'Planning keys come from the same recommend result as Plan');
  ok(!/F\.majorPlans\(|Forecast\.majorPlans\(/.test(planningCode),
    'Planning block does not call majorPlans itself');
  ok(!/amountMin\s*[-+*/]|amountMax\s*[-+*/]|\/\s*2/.test(planningCode),
    'Planning block does not average a range');
  ok(!/plan\.commitments/.test(planningCode),
    'Planning block does not read plan.commitments');
  ok(/F\.baselineTrajectory\(plan, data\.debts, asOf/.test(trajectoryCode),
    'trajectory keys come from Forecast.baselineTrajectory');
  ok(!/simulate\(|projectDebts\(|expandEvents\(/.test(trajectoryCode),
    'trajectory snapshot block does not re-walk Forecast');

  const liveSnap = buildFiguresSnapshot(live, periods);
  const liveAccounts = F.creditAccounts(live.plan, live.debts, live.meta.asOf, {
    extraFacilities: live.revolvingExtra,
  });
  const liveAdvice = snapshotRecommend(live);
  for (const row of [...liveAccounts.secured, ...liveAccounts.cards]) {
    if (row.shape !== 'secured-term') {
      ok(same(liveSnap[`credit.${row.id}.available`], row.available == null ? null : round(row.available)),
        `live ${row.id} available equals Forecast.creditAccounts, not a second formula`);
    }
    ok(same(liveSnap[`credit.${row.id}.minimum`], row.nextPayment ? round(row.nextPayment.amount) : null),
      `live ${row.id} minimum equals Forecast nextPayment`);
  }
  for (const row of liveAdvice.majorPlans || []) {
    ok(liveSnap[`planning.${row.id}.verdict`] === row.verdict,
      `live ${row.id} verdict equals advice.majorPlans`);
    ok(same(liveSnap[`planning.${row.id}.remaining`], round(row.remaining)),
      `live ${row.id} remaining equals advice.majorPlans`);
  }
  const liveBills = F.householdBills(live.plan, live.meta.asOf);
  ok(same(liveSnap['bills.monthlyEquivalentTotal'],
    liveBills.monthlyEquivalentTotal == null ? null : round(liveBills.monthlyEquivalentTotal)),
    'live bills total equals Forecast.householdBills, not a second formula');
  for (const row of liveBills.bills || []) {
    ok(same(liveSnap[`bills.${row.id}.amount`], row.amount == null ? null : round(row.amount)),
      `live ${row.id} amount equals Forecast.householdBills`);
    ok(liveSnap[`bills.${row.id}.frequency`] === row.frequency,
      `live ${row.id} frequency equals Forecast.householdBills`);
    ok(same(liveSnap[`bills.${row.id}.monthlyEquivalent`],
      row.monthlyEquivalent == null ? null : round(row.monthlyEquivalent)),
      `live ${row.id} monthly equivalent equals Forecast.householdBills`);
  }
  const liveSubscriptions = F.householdSubscriptions(live.plan, live.meta.asOf);
  ok(same(liveSnap['subscriptions.monthlyEquivalentTotal'],
    liveSubscriptions.monthlyEquivalentTotal == null ? null : round(liveSubscriptions.monthlyEquivalentTotal)),
    'live subscriptions total equals Forecast.householdSubscriptions, not a second formula');
  for (const row of liveSubscriptions.subscriptions || []) {
    ok(same(liveSnap[`subscriptions.${row.id}.amount`], row.amount == null ? null : round(row.amount)),
      `live ${row.id} amount equals Forecast.householdSubscriptions`);
    ok(liveSnap[`subscriptions.${row.id}.frequency`] === row.frequency,
      `live ${row.id} frequency equals Forecast.householdSubscriptions`);
    ok(same(liveSnap[`subscriptions.${row.id}.monthlyEquivalent`],
      row.monthlyEquivalent == null ? null : round(row.monthlyEquivalent)),
      `live ${row.id} monthly equivalent equals Forecast.householdSubscriptions`);
  }
}

console.log('\n=== 4. Existing Plan snapshot coverage remains intact ===');
{
  const liveSnap = buildFiguresSnapshot(live, periods);
  const mainSnap = runReferenceSnapshot(MAIN);
  // The owner-authorized canonical cutover renames exactly one held-cash
  // classification. Its dated value must be conserved, never duplicated or
  // inferred as a fresh pool balance. Every other Plan key retains its guard.
  const priorReserve = Object.prototype.hasOwnProperty.call(mainSnap, 'cash.elsewhere.staging')
    ? mainSnap['cash.elsewhere.staging'] : mainSnap['cash.elsewhere.purpose-reserve'];
  ok(same(liveSnap['cash.elsewhere.purpose-reserve'], priorReserve),
    'purpose class preserves the identical dated staging cash amount');
  ok(!Object.prototype.hasOwnProperty.call(liveSnap, 'cash.elsewhere.staging'),
    'the same dated cash is not also published as staging');
  const missing = PLAN_KEYS_ON_MAIN.filter(k => !Object.prototype.hasOwnProperty.call(liveSnap, k));
  ok(missing.length === 0, 'every current Plan contract key is present after the explicit class cutover',
    missing.join(', '));
  // G1 re-derives exactly one incumbent key. payday.riskShortfall now reads
  // the risk rows of the page's own recommend() call, which passes `periods`
  // (public/plan.js:8144-8157); the pre-G1 script called recommend() without
  // it and published a figure the page does not show. Its value is pinned
  // independently below, never by main's copy.
  const REDERIVED = ['operating.this.projectedEnding', 'payday.riskShortfall'];
  const incumbentKeys = PLAN_KEYS_ON_MAIN.filter(k =>
    Object.prototype.hasOwnProperty.call(mainSnap, k)
    && !REDERIVED.includes(k));
  const moved = incumbentKeys.filter(k => !same(liveSnap[k], mainSnap[k]));
  ok(moved.length === 0, 'Plan-key values that existed on main still match main\'s snapshot script',
    moved.map(k => `${k}:${mainSnap[k]}→${liveSnap[k]}`).join(', '));
  {
    // Independent of the snapshot's option assembly: the Budget page's default
    // call written out here from plan.js (simOpts, wireControls, renderPlan).
    const priority = F.debtPriority(live.plan, live.debts);
    const pageAdvice = F.recommend(live.plan, live.meta.asOf, {
      scenario: live.plan.defaults.scenario, targetBuffer: live.plan.defaults.targetBuffer,
      extraDebtMonthly: live.plan.defaults.extraDebtMonthly, incomeOverrides: {}, disabled: [],
      debts: live.debts, extraDebtTarget: priority.target && priority.target.id,
      extraFacilities: live.revolvingExtra, fundingSources: live.plan.funding && live.plan.funding.options,
      periods, currentPeriodActuals: null,
    });
    const risks = (pageAdvice.paydayAllocation && pageAdvice.paydayAllocation.risks) || [];
    const pageRisk = round(risks.reduce((sum, row) => sum + (row.shortfall || 0), 0));
    ok(Object.prototype.hasOwnProperty.call(liveSnap, 'payday.riskShortfall')
        && same(liveSnap['payday.riskShortfall'], pageRisk),
      'payday.riskShortfall equals the shortfalls of the page-equivalent recommend() risk rows');
  }
  ok(Object.prototype.hasOwnProperty.call(liveSnap, 'operating.this.projectedEnding'),
    'operating.this.projectedEnding remains the stable remainder key');
  const extraPlan = Object.keys(liveSnap).filter(k => PLAN_PREFIX.test(k) && !PLAN_KEYS_ON_MAIN.includes(k));
  ok(extraPlan.length === 0, 'no extra Plan-prefix keys were introduced', extraPlan.join(', '));
}

console.log('\n=== 4b. Household Budget Total is snapshotted from Forecast budgetHold ===');
{
  const liveSnap = buildFiguresSnapshot(live, periods);
  const liveAdvice = snapshotRecommend(live);
  const periodsView = (liveAdvice.defaultView && liveAdvice.defaultView.calendarPeriods) || [];
  const thisPeriod = periodsView.find(p => p && p.id === 'this-pay-period')
    || periodsView.find(p => p && p.role === 'active');
  const nextPeriod = periodsView.find(p => p && p.id === 'next-pay-period')
    || periodsView.find(p => p && p.role === 'future');
  const beforeSnap = runReferenceSnapshot(BEFORE_HOUSEHOLD_BUDGET_TOTAL);
  ok(thisPeriod && thisPeriod.budgetHold != null,
    'live this-pay-period publishes Forecast budgetHold');
  ok(same(liveSnap['operating.this.householdBudgetTotal'], round(thisPeriod.budgetHold)),
    'operating.this.householdBudgetTotal is Forecast calendarPeriods[].budgetHold',
    String(liveSnap['operating.this.householdBudgetTotal']));
  ok(nextPeriod && Object.prototype.hasOwnProperty.call(liveSnap, 'operating.next.householdBudgetTotal')
      && same(liveSnap['operating.next.householdBudgetTotal'],
        nextPeriod.budgetHold == null ? null : round(nextPeriod.budgetHold)),
    'operating.next.householdBudgetTotal is Forecast next-period budgetHold');
  if (thisPeriod.afterBills != null && thisPeriod.afterHouseholdBudget != null) {
    ok(same(round(thisPeriod.afterBills - liveSnap['operating.this.householdBudgetTotal']),
        round(thisPeriod.afterHouseholdBudget)),
      'snapshotted Household Budget Total reconciles afterBills − total = afterHouseholdBudget');
  } else {
    ok(thisPeriod.afterBills == null && thisPeriod.afterHouseholdBudget == null
        && thisPeriod.budgetHold != null,
      'snapshotted leftover withholds PEB when payday-boundary opening is unproven; hold is still Forecast budgetHold');
  }
  ok(!Object.prototype.hasOwnProperty.call(beforeSnap, 'operating.this.householdBudgetTotal')
      && !Object.prototype.hasOwnProperty.call(beforeSnap, 'operating.next.householdBudgetTotal'),
    'pre-PR #264 snapshot script does not key Household Budget Total — the historical absence proof stays fixed');
  const operatingSrc = snapSrc.split('const operating =')[1]
    && snapSrc.split('const operating =')[1].split('const T =')[0];
  ok(operatingSrc && /thisPeriod\.budgetHold/.test(operatingSrc)
      && /nextPeriod\.budgetHold/.test(operatingSrc)
      && /householdBudgetTotal/.test(operatingSrc)
      && !/\.reduce\s*\(/.test(operatingSrc)
      && !/Math\.max/.test(operatingSrc)
      && !/row\.hold/.test(operatingSrc),
    'snapshot copies period.budgetHold and does not recompute the Household Budget deduction');
}

console.log('\n=== 4c. Other Income and Total income are snapshotted from Forecast ===');
{
  const liveSnap = buildFiguresSnapshot(live, periods);
  const liveAdvice = snapshotRecommend(live);
  const periodsView = (liveAdvice.defaultView && liveAdvice.defaultView.calendarPeriods) || [];
  const thisPeriod = periodsView.find(p => p && p.id === 'this-pay-period')
    || periodsView.find(p => p && p.role === 'active');
  const nextPeriod = periodsView.find(p => p && p.id === 'next-pay-period')
    || periodsView.find(p => p && p.role === 'future');
  const thisOther = thisPeriod && thisPeriod.otherIncome
    ? round(thisPeriod.otherIncome.amount) : null;
  const nextOther = nextPeriod && nextPeriod.otherIncome
    ? round(nextPeriod.otherIncome.amount) : null;
  ok(thisPeriod && Object.prototype.hasOwnProperty.call(thisPeriod, 'incomeTotal'),
    'live this-pay-period publishes Forecast incomeTotal');
  ok(same(liveSnap['operating.this.otherIncome'], thisOther),
    'operating.this.otherIncome is Forecast calendarPeriods[].otherIncome.amount',
    String(liveSnap['operating.this.otherIncome']));
  ok(same(liveSnap['operating.this.incomeTotal'],
    thisPeriod.incomeTotal == null ? null : round(thisPeriod.incomeTotal)),
    'operating.this.incomeTotal is Forecast calendarPeriods[].incomeTotal');
  ok(same(liveSnap['operating.next.otherIncome'], nextOther)
      && same(liveSnap['operating.next.incomeTotal'],
        nextPeriod && nextPeriod.incomeTotal == null ? null : round(nextPeriod.incomeTotal)),
    'next-period Other Income and Total income are Forecast fields');
  const operatingSrc = snapSrc.split('const operating =')[1]
    && snapSrc.split('const operating =')[1].split('const T =')[0];
  ok(operatingSrc && /thisPeriod\.otherIncome/.test(operatingSrc)
      && /thisPeriod\.incomeTotal/.test(operatingSrc)
      && /nextPeriod\.otherIncome/.test(operatingSrc)
      && /nextPeriod\.incomeTotal/.test(operatingSrc)
      && !/\.reduce\s*\(/.test(operatingSrc),
    'snapshot copies Forecast otherIncome.amount / incomeTotal; it does not sum the rows');
}

console.log('\n=== 4d. This-period remainder key is Balance After Deductions, not after-purchase leftover ===');
{
  const INCOME = 6652.30;
  const BILLS = 3413.07;
  const HOLD = 2287.17;
  const independentBad = round(INCOME - BILLS - HOLD);
  const fx = {
    meta: { asOf: '2026-09-18' },
    revolvingExtra: [],
    debts: [],
    plan: {
      defaults: { scenario: 'expected', targetBuffer: 500, extraDebtMonthly: 0 },
      windowDays: 14,
      startingCash: {
        breakdown: [{ id: 'chequing-a', label: 'BILLS ACCOUNT', value: 593.29 }],
      },
      opening: {
        asOf: '2026-09-18',
        priorAsOf: '2026-09-11',
        paydaySnapshot: { periodStart: '2026-09-11', asOf: '2026-09-11', opening: 310.47 },
      },
      income: [
        {
          id: 'payroll', label: 'Dale income', frequency: 'biweekly',
          anchor: '2026-08-14', amount: 4274.98, confidence: 'confirmed',
        },
        {
          id: 'amandaPayday', label: 'Amanda income', frequency: 'once',
          date: '2026-09-11', amount: 2168.85, confidence: 'confirmed',
        },
        {
          id: 'childBenefit', label: 'Canada Child Benefit', frequency: 'once',
          date: '2026-09-20', amount: 208.47, confidence: 'confirmed',
        },
      ],
      bills: [{
        id: 'synthetic-bills', label: 'Assigned period bills',
        frequency: 'once', date: '2026-09-12', amount: BILLS, confidence: 'confirmed',
      }],
      obligations: [],
      commitments: [{
        id: 'road-ahead', label: 'Road Ahead purchase',
        amount: 8000, when: 'later', confidence: 'estimated',
      }],
      budget: {
        categories: [{
          id: 'groceries', label: 'Groceries', class: 'essential',
          from: ['Groceries'], plannedPayday: HOLD, ownerLine: 'Groceries',
        }],
      },
    },
  };
  const snap = buildFiguresSnapshot(fx, null);
  const advice = snapshotRecommend(fx);
  const thisPeriod = ((advice.defaultView && advice.defaultView.calendarPeriods) || [])
    .find(p => p && p.id === 'this-pay-period')
    || ((advice.defaultView && advice.defaultView.calendarPeriods) || [])
      .find(p => p && p.role === 'active');
  ok(thisPeriod && same(thisPeriod.incomeTotal, INCOME)
      && same(thisPeriod.periodBillLoad, BILLS)
      && same(thisPeriod.budgetHold, HOLD),
    'synthetic period terms are the independent income / bills / hold amounts');
  ok(same(independentBad, 952.06),
    'independent reconstruction is Income − Bills − Household Budget');
  ok(thisPeriod && same(thisPeriod.afterHouseholdBudget, independentBad)
      && same(thisPeriod.predictedEndingBalance, independentBad),
    'Forecast Balance After Deductions equals the independent reconstruction');
  ok(thisPeriod && same(thisPeriod.projectedEnding, 500)
      && same(thisPeriod.afterBigPurchases, 500)
      && !same(thisPeriod.projectedEnding, independentBad),
    'Forecast projectedEnding is the $500 after-purchase buffer leftover, not BAD');
  ok(same(snap['operating.this.projectedEnding'], independentBad)
      && !same(snap['operating.this.projectedEnding'], thisPeriod.projectedEnding),
    'snapshot this-period remainder publishes independent BAD, not afterBigPurchases');
  const operatingSrc = snapSrc.split('const operating =')[1]
    && snapSrc.split('const operating =')[1].split('const T =')[0];
  ok(operatingSrc && /predictedEndingBalance/.test(operatingSrc)
      && /afterHouseholdBudget/.test(operatingSrc)
      && !/put\('operating\.this\.projectedEnding',\s*thisPeriod\.projectedEnding\)/.test(operatingSrc),
    'snapshot copies this-period BAD fields; it does not copy projectedEnding');
}

console.log('\n=== 5. Output is deterministic ===');
{
  const a = buildFiguresSnapshot(live, periods);
  const b = buildFiguresSnapshot(live, periods);
  ok(JSON.stringify(a) === JSON.stringify(b),
    'buildFiguresSnapshot is byte-identical across two calls');
  const cli = runCli(['--household-only']);
  ok(JSON.stringify(cli) === JSON.stringify(a),
    'CLI --household-only stdout is exactly buildFiguresSnapshot of canonical data.json');
  const checkCli = runCli();
  // The household's page-capture evidence (G1 v3) is unprefixed beside the
  // household map; it is not part of buildFiguresSnapshot.
  const householdPart = Object.fromEntries(Object.entries(checkCli)
    .filter(([k]) => !/^(check|coverage|fixture)\./.test(k) && !k.startsWith('savings.capture.')));
  ok(JSON.stringify(householdPart) === JSON.stringify(a),
    'the default check snapshot carries exactly that household map, unprefixed');
  ok(typeof checkCli['savings.capture.version'] === 'string' && Number.isSafeInteger(checkCli['savings.capture.count']),
    'and the household page-capture evidence beside it');
  const keys = Object.keys(a);
  const sorted = [...keys].sort();
  ok(JSON.stringify(Object.keys(cli)) === JSON.stringify(keys),
    'CLI key order matches the builder');
  ok(keys.filter(k => k.startsWith('credit.')).length > 0
    && keys.filter(k => k.startsWith('planning.')).length > 0,
    'canonical snapshot includes both credit.* and planning.* keys');
  void sorted;
}

console.log('\n=== live household surfaces are covered ===');
{
  const snap = buildFiguresSnapshot(live, periods);
  const accounts = F.creditAccounts(live.plan, live.debts, live.meta.asOf, {
    extraFacilities: live.revolvingExtra,
  });
  const advice = snapshotRecommend(live);
  const liveIds = [...accounts.secured, ...accounts.cards].map(r => r.id);
  ok(liveIds.length >= 5 && liveIds.every(id => Object.prototype.hasOwnProperty.call(snap, `credit.${id}.balance`)),
    `live Credit accounts (${liveIds.join(', ')}) each have balance keys`);
  const revolving = [...accounts.secured, ...accounts.cards].filter(r => r.shape !== 'secured-term');
  ok(revolving.every(r => Object.prototype.hasOwnProperty.call(snap, `credit.${r.id}.available`)
    && Object.prototype.hasOwnProperty.call(snap, `credit.${r.id}.limit`)),
    'live revolving Credit accounts each have limit and available keys');
  ok(liveIds.every(id => Object.prototype.hasOwnProperty.call(snap, `credit.${id}.minimum`)
    && Object.prototype.hasOwnProperty.call(snap, `credit.${id}.due`)),
    'live Credit accounts each have minimum and due keys');
  const planIds = (advice.majorPlans || []).map(r => r.id);
  ok(planIds.length >= 1 && planIds.every(id => snap[`planning.${id}.verdict`]),
    `live majorPlans (${planIds.join(', ')}) each have a verdict key`);
  ok(planIds.every(id => Object.prototype.hasOwnProperty.call(snap, `planning.${id}.remaining`)),
    'live majorPlans each have a remaining key');
  const ranges = (advice.majorPlans || []).filter(r => r.need == null && r.amountMin != null && r.amountMax != null);
  ok(ranges.length === 0, 'live majorPlans has no range after the 2026-09-23 retirements');
  ok(ranges.every(r =>
    same(snap[`planning.${r.id}.amountMin`], round(r.amountMin))
    && same(snap[`planning.${r.id}.amountMax`], round(r.amountMax))),
    `live ranges (${ranges.map(r => r.id).join(', ') || 'none'}) keep min/max`);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
