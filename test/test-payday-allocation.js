'use strict';
/* Forecast.paydayAllocation — independent numerical proof.
 *
 * Synthetic fixtures only. Live household cents are not the specification
 * (L-006). Protected current cash is proved against the incumbent master
 * Forecast walk (simulate + fundingSequence), not by reading paydayAllocation
 * back to itself.
 *
 * `node test/test-payday-allocation.js`
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b, eps = 0.02) => Math.abs(Number(a) - Number(b)) <= eps;
const AS_OF = '2026-09-01';
const MONTH = 365.25 / 12;
const EPS = 0.005;

function line(alloc, keyOrKind) {
  return (alloc.lines || []).find(l => l.key === keyOrKind || l.kind === keyOrKind || l.id === keyOrKind) || null;
}
function future(alloc, id) {
  return (alloc.futureCosts || []).find(r => r.id === id) || null;
}
function recon(alloc) {
  const sum = (alloc.lines || []).reduce((s, l) => s + l.amount, 0) + alloc.unallocated;
  return near(sum, alloc.available) && near(alloc.identity, alloc.available);
}
function downstream(alloc) {
  const extra = alloc.extraDebt && alloc.extraDebt.allocated || 0;
  const opt = (alloc.optional || []).reduce((s, r) => s + (r.allocated || 0), 0);
  return extra + opt;
}

function opts(extra) {
  return Object.assign({
    paydayFloor: 100,
    targetBuffer: 0,
    debts: [],
    extraFacilities: [],
    extraDebtMonthly: 0,
  }, extra || {});
}

function planA(extra) {
  return Object.assign({
    windowDays: 200,
    defaults: { targetBuffer: 0 },
    startingCash: { amount: 500 },
    income: [
      { id: 'p1', label: 'Pay 1', frequency: 'once', date: '2026-09-15', amount: 560, confidence: 'confirmed' },
      { id: 'p2', label: 'Pay 2', frequency: 'once', date: '2026-12-01', amount: 5200, confidence: 'confirmed' },
    ],
    obligations: [],
    bills: [],
    commitments: [
      { id: 'oct', label: 'October cost', date: '2026-10-10', amount: 700, confidence: 'confirmed' },
      { id: 'later', label: 'Later cost', date: '2027-01-15', amount: 5500, confidence: 'confirmed' },
    ],
  }, extra || {});
}

const CARD = [{ id: 'card', label: 'Card', balance: 8000, rate: 19.99, limit: 10000, secured: false }];
const HELOC = [{ id: 'heloc', label: 'HELOC', balance: 0, rate: 5.45, limit: 25000, secured: true }];

function masterHolds(plan, asOf, o, removeX, disabled) {
  const weekly = o.weeklyVariable != null ? Number(o.weeklyVariable) || 0 : 0;
  const buffer = o.targetBuffer != null ? o.targetBuffer
    : ((plan.defaults && plan.defaults.targetBuffer) || 0);
  const extraDisabled = disabled || [];
  const probe = Object.assign({}, o, {
    weeklyVariable: weekly,
    disabled: (o.disabled || []).concat(extraDisabled),
  });
  const horizon = F.knowledgeHorizon(plan, asOf, probe);
  probe.horizonDays = horizon.days;
  probe.viewDays = horizon.days;
  const amt = Math.round(Number(removeX || 0) * 100) / 100;
  if (amt > EPS) {
    probe.plannedFlows = (o.plannedFlows || []).concat([{
      date: asOf, amount: -amt, id: 'proof-remove', label: 'proof',
    }]);
  } else if (amt < -EPS) {
    probe.injections = (o.injections || []).concat([{
      date: asOf, amount: -amt, id: 'proof-add', label: 'proof',
    }]);
  }
  const sim = F.simulate(plan, asOf, probe);
  const seq = F.fundingSequence(plan, asOf, probe);
  if (sim.min.balance < buffer - EPS) return false;
  for (const item of seq) {
    if (!item.date || item.flexibility === 'optional' || item.need == null) continue;
    if (item.date < asOf) continue;
    const day = (sim.daily || []).find(d => d.date === item.date);
    if (!day || day.balance < buffer - EPS) return false;
  }
  let enc = 0;
  for (const item of seq) {
    if (!item || item.flexibility === 'optional') continue;
    const futureCash = item.date && item.need != null && item.date >= asOf;
    if (futureCash) continue;
    enc += item.bounds ? item.bounds.floor : (item.need || 0);
  }
  if ((sim.ending - sim.buffer) < enc - EPS) return false;
  return true;
}

function maxRemoval(plan, asOf, o, hi, disabled) {
  const cap = Math.max(0, Math.round((hi || 0) * 100));
  const fits = cents => masterHolds(plan, asOf, o, cents / 100, disabled);
  if (fits(cap)) return cap / 100;
  if (!fits(0)) return 0;
  let lo = 0, high = cap;
  while (lo + 1 < high) {
    const mid = lo + Math.floor((high - lo) / 2);
    if (fits(mid)) lo = mid;
    else high = mid;
  }
  return lo / 100;
}

function assertMasterWalk(plan, asOf, o, alloc, label) {
  const moved = downstream(alloc);
  ok(masterHolds(plan, asOf, o, moved),
    `${label}: removing labeled downstream cash leaves the master Forecast feasible`,
    `downstream ${moved}`);
  if (near(alloc.unallocated, 0)) {
    ok(!masterHolds(plan, asOf, o, moved + 1),
      `${label}: one more dollar past the protected boundary fails`,
      `tried ${moved + 1}`);
  }
  ok(recon(alloc), `${label} reconciles`);
}

function paydayComposer() {
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const planSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'plan.js'), 'utf8');
  const grab = (src, re, label) => {
    const m = re.exec(src);
    if (!m) throw new Error('missing ' + label);
    return m[0];
  };
  return vm.runInNewContext(
    [
      grab(appSrc, /^const money = .*$/m, 'money'),
      grab(appSrc, /^const money2 = .*$/m, 'money2'),
      grab(appSrc, /^const escapeHtml = .*$/m, 'escapeHtml'),
      grab(appSrc, /^const fmtDate = .*$/m, 'fmtDate'),
      grab(appSrc, /^const fmtDateLong = .*$/m, 'fmtDateLong'),
      grab(planSrc, /^const fmtMonth = .*$/m, 'fmtMonth'),
      grab(planSrc, /^function weeklyCapView\([\s\S]*?\n\}$/m, 'weeklyCapView'),
      grab(planSrc, /^function liveOperatingPlanUnavailable\([\s\S]*?\n\}$/m, 'liveOperatingPlanUnavailable'),
      grab(planSrc, /^function liveOperatingPlanNote\([\s\S]*?\n\}$/m, 'liveOperatingPlanNote'),
      grab(planSrc, /^function currentOperatingUnavailableHtml\([\s\S]*?\n\}$/m, 'currentOperatingUnavailableHtml'),
      grab(planSrc, /^function paydayActionRows\([\s\S]*?\n\}$/m, 'paydayActionRows'),
      grab(planSrc, /^function paydayOtherActionRows\([\s\S]*?\n\}$/m, 'paydayOtherActionRows'),
      grab(planSrc, /^function paydayReservedIds\([\s\S]*?\n\}$/m, 'paydayReservedIds'),
      grab(planSrc, /^function paydayComingRows\([\s\S]*?\n\}$/m, 'paydayComingRows'),
      grab(planSrc, /^function paydaySheet\([\s\S]*?\n\}$/m, 'paydaySheet'),
      grab(planSrc, /^function paydayCashNote\([\s\S]*?\n\}$/m, 'paydayCashNote'),
      grab(planSrc, /^function paydayObligationNote\([\s\S]*?\n\}$/m, 'paydayObligationNote'),
      grab(planSrc, /^function paydayCoverageNote\([\s\S]*?\n\}$/m, 'paydayCoverageNote'),
      grab(planSrc, /^function paydayBillStatusNote\([\s\S]*?\n\}$/m, 'paydayBillStatusNote'),
      grab(planSrc, /^function paydayAmountCell\([\s\S]*?\n\}$/m, 'paydayAmountCell'),
      grab(planSrc, /^function paydayAnswerHtml\([\s\S]*?\n\}$/m, 'paydayAnswerHtml'),
      '({ paydayActionRows, paydayOtherActionRows, paydayComingRows, paydayAnswerHtml, paydayCashNote, money2 })',
    ].join('\n'),
    { Forecast: F }
  );
}

function deadlineReconciles(row, label) {
  ok(!!row, `${label} exists`);
  if (!row) return;
  ok(near(row.need, (row.projectedByDeadline || 0) + (row.shortfall || 0)),
    `${label}: need = projectedByDeadline + shortfall`,
    `${row.need} vs ${row.projectedByDeadline} + ${row.shortfall}`);
  if (row.verdict === 'ON TRACK') {
    ok(near(row.shortfall, 0) && near(row.projectedByDeadline, row.need),
      `${label}: ON TRACK projects the full target by the deadline`);
  }
  if (row.verdict === 'FUNDING GAP') {
    ok(row.shortfall > 0, `${label}: FUNDING GAP has a positive shortfall`);
  }
}

console.log('=== A. master walk agreement ===');
{
  const fixtures = [
    ['planA', planA(), opts({ debts: CARD })],
    ['quiet cash', {
      windowDays: 40, defaults: { targetBuffer: 0 }, startingCash: { amount: 2000 },
      income: [{ id: 'pay', label: 'Pay', frequency: 'once', date: '2026-09-15', amount: 1000, confidence: 'confirmed' }],
      obligations: [], bills: [{ id: 'small', label: 'Small', frequency: 'once', date: '2026-09-16', amount: 100, confidence: 'confirmed' }],
      commitments: [],
    }, opts()],
  ];
  for (const [name, plan, o] of fixtures) {
    const alloc = F.paydayAllocation(plan, AS_OF, o);
    assertMasterWalk(plan, AS_OF, o, alloc, name);
    ok(near(alloc.movable, maxRemoval(plan, AS_OF, o, alloc.available - alloc.obligations.allocated - alloc.essentials.allocated)),
      `${name}: allocator movable matches independent master-walk search`,
      `${alloc.movable}`);
  }
}

console.log('\n=== B. buffer is not double-counted ===');
{
  const fixture = {
    windowDays: 200,
    defaults: { targetBuffer: 500 },
    startingCash: { amount: 2000 },
    income: [
      { id: 'p1', label: 'Pay 1', frequency: 'once', date: '2026-09-15', amount: 1000, confidence: 'confirmed' },
      { id: 'p2', label: 'Pay 2', frequency: 'once', date: '2026-10-15', amount: 500, confidence: 'confirmed' },
    ],
    obligations: [],
    bills: [{ id: 'heavy', label: 'Heavy', frequency: 'once', date: '2026-10-16', amount: 2500, confidence: 'confirmed' }],
    commitments: [],
  };
  const o = opts({ targetBuffer: 500, debts: CARD });
  const leftover = 2000;
  const independentMovable = maxRemoval(fixture, AS_OF, o, leftover);
  const alloc = F.paydayAllocation(fixture, AS_OF, o);
  ok(near(independentMovable, 500),
    'independent master walk can release $500 after protecting buffer and later deficit',
    String(independentMovable));
  ok(near(alloc.protectedPath.allocated, leftover - independentMovable)
    && near(alloc.extraDebt.allocated, independentMovable),
    'allocator protects exactly the master-walk requirement and releases only the rest',
    `path ${alloc.protectedPath.allocated} extra ${alloc.extraDebt.allocated}`);
  ok(masterHolds(fixture, AS_OF, o, alloc.extraDebt.allocated),
    'releasing the extra-debt dollars keeps the protected buffer and later bill feasible');
  ok(!masterHolds(fixture, AS_OF, o, alloc.extraDebt.allocated + 1),
    'one more extra-debt dollar breaches the master Forecast');
  ok(recon(alloc), 'B reconciles');
}

console.log('\n=== C. deficit larger than future surplus ===');
{
  const fixture = {
    windowDays: 200,
    defaults: { targetBuffer: 0 },
    startingCash: { amount: 3000 },
    income: [
      { id: 'p1', label: 'Pay 1', frequency: 'once', date: '2026-09-15', amount: 500, confidence: 'confirmed' },
      { id: 'p2', label: 'Pay 2', frequency: 'once', date: '2026-10-15', amount: 1000, confidence: 'confirmed' },
    ],
    obligations: [],
    bills: [{ id: 'heavy', label: 'Heavy', frequency: 'once', date: '2026-10-16', amount: 2500, confidence: 'confirmed' }],
    commitments: [{ id: 'later', label: 'Later cost', date: '2026-11-20', amount: 2000, confidence: 'confirmed' }],
  };
  const o = opts({ debts: CARD });
  const leftover = 3000;
  const independentMovable = maxRemoval(fixture, AS_OF, o, leftover);
  const withoutLater = maxRemoval(fixture, AS_OF, o, leftover, ['later']);
  const alloc = F.paydayAllocation(fixture, AS_OF, o);
  const later = future(alloc, 'later');
  ok(near(independentMovable, 0),
    'independent master walk cannot release current cash',
    String(independentMovable));
  ok(near(withoutLater, 2000),
    'disabling the later commitment independently frees $2,000 — that cash was for the commitment, not the household deficit',
    String(withoutLater));
  ok(later && near(later.allocated, 2000),
    'the dated commitment keeps its master-walk current funding',
    later && String(later.allocated));
  ok(near(alloc.protectedPath.allocated, 1000),
    'the uncovered household deficit stays protected as future-path cash',
    String(alloc.protectedPath.allocated));
  ok(near(alloc.extraDebt.allocated, 0),
    'that cash is not released to extra debt',
    String(alloc.extraDebt.allocated));

  const amplePlan = Object.assign({}, fixture, { startingCash: { amount: 4000 } });
  const ample = F.paydayAllocation(amplePlan, AS_OF, o);
  ok(near(ample.extraDebt.allocated, 1000)
    && near(ample.protectedPath.allocated, 1000)
    && near(future(ample, 'later').allocated, 2000),
    'only cash above the master-walk requirement can go to extra debt',
    `path ${ample.protectedPath.allocated} later ${future(ample, 'later').allocated} extra ${ample.extraDebt.allocated}`);
  assertMasterWalk(fixture, AS_OF, o, alloc, 'tight deficit');
  assertMasterWalk(amplePlan, AS_OF, o, ample, 'ample deficit');
}

console.log('\n=== D. nearer small / later large ===');
{
  const plan = planA();
  const o = opts();
  const leftover = 500;
  const both = maxRemoval(plan, AS_OF, o, leftover);
  const withoutLater = maxRemoval(plan, AS_OF, o, leftover, ['later']);
  const withoutBoth = maxRemoval(plan, AS_OF, o, leftover, ['later', 'oct']);
  const laterNow = withoutLater - both;
  const octNow = withoutBoth - withoutLater;
  ok(near(octNow, 140) && near(laterNow, 300),
    'independent master walk requires $140 now for October and $300 now for later',
    `${octNow} / ${laterNow}`);
  const alloc = F.paydayAllocation(plan, AS_OF, o);
  const oct = future(alloc, 'oct');
  const later = future(alloc, 'later');
  ok(oct && near(oct.allocated, octNow) && oct.allocated < 700,
    'October receives only the current set-aside the master walk needs',
    oct && String(oct.allocated));
  ok(later && near(later.allocated, laterNow) && later.allocated > 0,
    'the later larger commitment also receives current funding',
    later && String(later.allocated));
  ok(oct.allocated + later.allocated < leftover || near(alloc.unallocated, leftover - octNow - laterNow),
    'cash is not exhausted on the nearer item');
  deadlineReconciles(oct, 'October ON TRACK');
  deadlineReconciles(later, 'later ON TRACK');
  ok(oct && oct.verdict === 'ON TRACK' && !near(oct.projectedByDeadline, oct.allocated),
    'October projected-by-deadline is not this payday\'s $140 set-aside',
    oct && `${oct.projectedByDeadline} vs allocated ${oct.allocated}`);
  ok(later && later.verdict === 'ON TRACK' && near(later.projectedByDeadline, 5500)
    && !near(later.projectedByDeadline, later.allocated),
    'later projected-by-deadline is the $5,500 target, not the $300 set-aside',
    later && `${later.projectedByDeadline} vs allocated ${later.allocated}`);
  assertMasterWalk(plan, AS_OF, o, alloc, 'nearer/later');
}

console.log('\n=== E. variable future income ===');
{
  const fixture = planA({
    startingCash: { amount: 800 },
    income: [
      { id: 'a', label: 'A', frequency: 'once', date: '2026-09-15', amount: 100, confidence: 'confirmed' },
      { id: 'b', label: 'B', frequency: 'once', date: '2026-09-29', amount: 1000, confidence: 'confirmed' },
      { id: 'c', label: 'C', frequency: 'once', date: '2026-10-13', amount: 1000, confidence: 'confirmed' },
    ],
    commitments: [{ id: 'due', label: 'Due', date: '2026-10-10', amount: 1500, confidence: 'confirmed' }],
  });
  const o = opts();
  const leftover = 800;
  const requiredNow = leftover - maxRemoval(fixture, AS_OF, o, leftover);
  const naiveN = 1500 / 3;
  const naiveTwo = 1500 / 2;
  const alloc = F.paydayAllocation(fixture, AS_OF, o);
  const due = future(alloc, 'due');
  ok(due && near(due.allocated, requiredNow) && near(requiredNow, 400),
    'required now follows the master cash path ($100+$1,000 before the deadline)',
    due && `${due.allocated} vs independent ${requiredNow}`);
  ok(!near(due.allocated, naiveN) && !near(due.allocated, naiveTwo),
    'it is not remaining divided by the count of paycheques',
    `${due.allocated} vs /3=${naiveN} /2=${naiveTwo}`);
  assertMasterWalk(fixture, AS_OF, o, alloc, 'variable income');
}

console.log('\n=== F. redirection ===');
{
  const before = F.paydayAllocation(planA(), AS_OF, opts({ debts: CARD }));
  ok(future(before, 'oct') && future(before, 'oct').allocated > 0,
    'October takes a current set-aside before it is settled');
  const settled = planA();
  settled.commitments = settled.commitments.map(c =>
    c.id === 'oct' ? Object.assign({}, c, { settledOn: AS_OF }) : c);
  const after = F.paydayAllocation(settled, AS_OF, opts({ debts: CARD }));
  ok(!future(after, 'oct') || !(future(after, 'oct').allocated > 0),
    'settled October no longer takes a payday contribution');
  ok(after.extraDebt.allocated > before.extraDebt.allocated,
    'released capacity may become extra debt only if the master walk proves it surplus',
    `before ${before.extraDebt.allocated} after ${after.extraDebt.allocated}`);
  assertMasterWalk(settled, AS_OF, opts({ debts: CARD }), after, 'redirected');
}

console.log('\n=== G. required-undated ===');
{
  const leftoverAfterOct = 500 - 140;
  const fixture = planA({
    commitments: [
      { id: 'undated', label: 'Undated required', amount: 5000, confidence: 'confirmed' },
      { id: 'oct', label: 'October cost', date: '2026-10-10', amount: 700, confidence: 'confirmed' },
      { id: 'opt', label: 'Optional trip', date: '2027-06-01', amount: 2000, optional: true, confidence: 'confirmed' },
    ],
  });
  const withDebt = F.paydayAllocation(fixture, AS_OF, opts({ debts: CARD }));
  const unresolved = (withDebt.unresolved || []).find(r => r.id === 'undated');
  ok(unresolved && unresolved.flexibility === 'required' && unresolved.date == null,
    'required-undated stays unresolved, with no fabricated date');
  ok(!(withDebt.lines || []).some(l => l.id === 'undated'),
    'it receives no invented payday contribution line');
  ok(near(withDebt.extraDebt.allocated, 0),
    'residual cash is not released to extra debt solely because the date is unknown',
    String(withDebt.extraDebt.allocated));
  ok(!(withDebt.optional || []).some(r => r.allocated > 0),
    'owner-optional residual also does not take that cash');
  ok(withDebt.unallocated === null,
    'a required-undated input withholds the dependent unallocated amount');
  ok(future(withDebt, 'oct') && future(withDebt, 'oct').allocated === null,
    'dependent dated-cost allocation stays Unknown beside an unresolved requirement');
  ok(recon(withDebt), 'G reconciles');
}

console.log('\n=== H. no auto-borrow ===');
{
  const broke = planA({
    startingCash: { amount: 50 },
    commitments: [
      { id: 'oct', label: 'October cost', date: '2026-10-10', amount: 700, confidence: 'confirmed' },
      { id: 'later', label: 'Later cost', date: '2027-01-15', amount: 20000, confidence: 'confirmed' },
    ],
  });
  const alloc = F.paydayAllocation(broke, AS_OF, opts({ debts: HELOC }));
  ok(alloc.available === 50, 'available cash is still $50, not HELOC room');
  ok(alloc.plannedDebt.permitted === false && near(alloc.plannedDebt.borrowed, 0),
    'HELOC capacity is not treated as permission to borrow');
  ok((alloc.risks || []).some(r => r.verdict === 'FUNDING GAP' && r.shortfall > 0),
    'the cash shortfall remains a funding gap');
  ok(!(alloc.lines || []).some(l => /heloc|borrow/i.test(l.label)),
    'no allocation line is an automatic HELOC draw');
  const later = future(alloc, 'later');
  const plans = F.majorPlans(broke, AS_OF, opts({ debts: HELOC, weeklyVariable: 0 }));
  const laterPlan = (plans || []).find(p => p.id === 'later');
  const independentGap = laterPlan ? Math.max(0, Number(laterPlan.remaining) || 0) : 0;
  ok(later && later.verdict === 'FUNDING GAP' && independentGap > 0,
    'later commitment is a master-walk FUNDING GAP',
    later && `${later.verdict} remaining ${independentGap}`);
  deadlineReconciles(later, 'later FUNDING GAP');
  ok(later && !near(later.projectedByDeadline, later.allocated),
    'FUNDING GAP projected-by-deadline is not this payday\'s current allocation',
    later && `projected ${later.projectedByDeadline} allocated ${later.allocated}`);
  ok(later && near(later.shortfall, independentGap)
    && near(later.projectedByDeadline, later.need - independentGap),
    'projected-by-deadline is the majorPlans target minus the authoritative gap',
    later && `${later.projectedByDeadline} vs ${later.need} − ${independentGap}`);
  ok(recon(alloc), 'H reconciles');
}

console.log('\n=== I. essential hold vs spending permission ===');
{
  const DAYS = F.diffDays(AS_OF, '2026-09-14') + 1;
  const WEEKLY = 100;
  const ESSENTIAL_MONTHLY = 2000;
  const essWanted = ESSENTIAL_MONTHLY * DAYS / MONTH;
  const spendPermission = WEEKLY * DAYS / 7;
  ok(essWanted > spendPermission,
    'fixture essential hold exceeds the weekly-cap permission',
    `${essWanted.toFixed(2)} vs ${spendPermission.toFixed(2)}`);

  const fixture = {
    windowDays: 200,
    defaults: { targetBuffer: 0 },
    startingCash: { amount: 8000 },
    income: [
      { id: 'p1', label: 'Pay 1', frequency: 'once', date: '2026-09-15', amount: 400, confidence: 'confirmed' },
    ],
    obligations: [],
    bills: [
      { id: 'rent', label: 'Rent', frequency: 'once', date: '2026-09-05', amount: 300, confidence: 'confirmed' },
      { id: 'later-bill', label: 'Later bill', frequency: 'once', date: '2026-09-16', amount: 900, confidence: 'confirmed' },
    ],
    budget: { categories: [{ id: 'groc', label: 'Groceries', class: 'essential', plannedMonthly: ESSENTIAL_MONTHLY }] },
    commitments: [
      { id: 'oct', label: 'October cost', date: '2026-10-10', amount: 700, confidence: 'confirmed' },
      { id: 'nov', label: 'November cost', date: '2026-11-10', amount: 700, confidence: 'confirmed' },
      { id: 'undated', label: 'Undated required', amount: 4000, confidence: 'confirmed' },
    ],
  };
  const o = opts({ weeklyVariable: WEEKLY, debts: CARD });
  const held = F.paydayAllocation(fixture, AS_OF, o);
  ok(held.weeklyCap === null && held.spendPermission === null
    && (held.unresolved || []).some(row => row.id === 'undated'),
    'original required-undated input withholds permission and keeps the unresolved identity');
  const datedControl = structuredClone(fixture);
  datedControl.commitments.find(row => row.id === 'undated').date = '2027-01-15';
  const alloc = F.paydayAllocation(datedControl, AS_OF, o);
  const rec = { weekly: WEEKLY, paydayAllocation: alloc, mode: 'normal' };
  const material = (alloc.lines || []).filter(l => Number(l.amount) > 0 && l.label);
  ok(near(alloc.weeklyCap, WEEKLY) && near(alloc.spendPermission, spendPermission),
    'the weekly cap remains the spend permission',
    `${alloc.weeklyCap} / ${alloc.spendPermission}`);
  ok(near(alloc.essentials.wanted, essWanted) && alloc.essentials.role === 'reserve',
    'essential cash is a hold, independently the period essential need',
    String(alloc.essentials.allocated));
  ok(alloc.essentials.allocated > alloc.spendPermission,
    'the hold can exceed the weekly-cap permission without becoming a second spend figure');
  ok(near(alloc.supportedAllowance, spendPermission)
    && near(alloc.supportedAllowance, alloc.spendPermission)
    && !near(alloc.supportedAllowance, alloc.essentials.allocated),
    'supportedAllowance is the weekly-cap permission, not the essential reserve',
    `${alloc.supportedAllowance} vs permission ${alloc.spendPermission} reserve ${alloc.essentials.allocated}`);
  ok(alloc.essentials.role === 'reserve',
    'the essential bucket remains a reserve, not a second allowance');
  const essLine = line(alloc, 'essentials');
  ok(essLine && /hold/i.test(essLine.label) && !/household spending/i.test(essLine.label),
    'the essentials line is labeled as a hold, not household spending');
  ok(near(alloc.extraDebt.allocated, 0),
    'required-undated leftover is not released to extra debt');
  ok((held.unresolved || []).some(r => r.id === 'undated'),
    'original required-undated control is visible as unresolved');

  const composed = paydayComposer();
  const rows = composed.paydayActionRows({ advice: rec });
  ok(rows.length === material.length,
    'paydayActionRows still surfaces every material allocation line',
    `${rows.length} vs ${material.length}`);
  const html = composed.paydayAnswerHtml({
    plan: datedControl,
    asOf: AS_OF,
    advice: rec,
    recommended: WEEKLY,
    weekly: WEEKLY,
  });
  const heldHtml = composed.paydayAnswerHtml({ plan: fixture, asOf: AS_OF,
    advice: { weekly: null, paydayAllocation: held, mode: 'unavailable' }, recommended: null, weekly: null });
  ok(/Undated required/.test(heldHtml) && /no exact date stay unresolved/.test(heldHtml),
    'the original held fixture renders its required-undated identity and unresolved-date note');
  ok(material.every(l => html.includes(composed.money2(l.amount))),
    'composed HTML contains every material allocation amount');
  ok(/Household spending permission/.test(html) && html.includes(String(WEEKLY)),
    'composed HTML still publishes the weekly cap as the spend instruction');
  ok(/Groceries/.test(html) && /Required for period/.test(html)
    && /Cash available for essentials/.test(html)
    && (held.unresolved || []).some(row => row.id === 'undated'),
    'the dated essential category, period need and funded cash render; the separate original remains unresolved');
  ok(!/Keep for bills/.test(html) && !/Hold for essential costs/.test(html),
    'collapsed Keep-for-bills / Hold-for-essential-costs labels are not the household surface');
  ok(recon(alloc), 'I reconciles');
}

console.log('\n=== J. complete render ===');
{
  const manyLines = [1, 2, 3, 4, 5, 6].map(i => ({
    key: 'k' + i, label: 'Line ' + i, amount: 10 * i,
  }));
  const planSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'plan.js'), 'utf8');
  const composed = paydayComposer();
  const manyRows = composed.paydayActionRows({
    advice: { weekly: 100, paydayAllocation: { lines: manyLines } },
  });
  ok(manyRows.length === 6,
    'the page still renders more than five material lines when the engine produces them');
  const fn = /function paydayActionRows\([\s\S]*?\n\}$/m.exec(planSrc);
  const body = fn ? fn[0] : '';
  ok(/alloc\.lines/.test(body),
    'the composer reads Forecast.paydayAllocation.lines');
  ok(!/\.slice\(\s*0\s*,\s*5\s*\)/.test(body),
    'it does not drop allocation lines after the fifth');
  ok(!/b\.amount - a\.amount/.test(body),
    'it does not sort allocation lines by size');
}

console.log('\n=== K. reconciliation identity ===');
{
  const fixtures = [
    planA(),
    planA({ startingCash: { amount: 50 } }),
    planA({ bills: [{ id: 'rent', label: 'Rent', frequency: 'once', date: '2026-09-05', amount: 200, confidence: 'confirmed' }] }),
  ];
  for (const [i, p] of fixtures.entries()) {
    const alloc = F.paydayAllocation(p, AS_OF, opts({ debts: i === 2 ? CARD : [] }));
    const kinds = {};
    for (const l of alloc.lines || []) {
      ok(!kinds[l.key], `fixture ${i} line key ${l.key} is unique`);
      kinds[l.key] = true;
    }
    ok(recon(alloc), `fixture ${i} available = allocated + unallocated`,
      `${alloc.available} vs ${alloc.allocatedTotal} + ${alloc.unallocated}`);
    ok(near(alloc.available, alloc.opening + alloc.todayIncome),
      `fixture ${i} available is opening plus same-day income, not credit`);
  }
}

console.log('\n=== L. input independence ===');
{
  const run = amount => F.paydayAllocation(planA({
    startingCash: { amount: 2000 },
    income: [{ id: 'p1', label: 'Pay 1', frequency: 'once', date: '2026-12-01', amount: 1000, confidence: 'confirmed' }],
    commitments: [{ id: 'goal', label: 'Season goal', date: '2027-01-15', amount, confidence: 'confirmed' }],
  }), AS_OF, opts());
  const a = run(3500);
  const b = run(4000);
  const g3500 = future(a, 'goal');
  const g4000 = future(b, 'goal');
  ok(g3500 && g4000 && g4000.requiredNow > g3500.requiredNow,
    'raising a generic future commitment amount raises required-now',
    `${g3500.requiredNow} → ${g4000.requiredNow}`);
  ok(g4000.shortfall > g3500.shortfall,
    'the same algorithm recomputes the gap; no commitment id is special-cased');
  ok(recon(a) && recon(b), 'L reconciles');
}

console.log('\n=== future-cost confidence is retained ===');
{
  const datedCommitment = {
    id: 'oct', label: 'October cost', date: '2026-10-10', amount: 700, confidence: 'estimated',
  };
  const undatedCommitment = {
    id: 'undated', label: 'Undated required', amount: 5000, confidence: 'estimated',
  };
  const fixture = planA({
    commitments: [datedCommitment, undatedCommitment],
  });
  const seq = F.fundingSequence(fixture, AS_OF, opts());
  const datedSeq = seq.find(r => r.id === datedCommitment.id);
  const undatedSeq = seq.find(r => r.id === undatedCommitment.id);
  ok(datedSeq && datedSeq.confidence === datedCommitment.confidence,
    'fundingSequence keeps the dated commitment\'s estimated confidence');
  ok(undatedSeq && undatedSeq.confidence === undatedCommitment.confidence && !undatedSeq.date,
    'fundingSequence keeps the undated commitment\'s estimated confidence and invents no date');

  const alloc = F.paydayAllocation(fixture, AS_OF, opts());
  const dated = future(alloc, datedCommitment.id);
  const datedLine = (alloc.lines || []).find(l =>
    l.key === 'future:' + datedCommitment.id || l.id === datedCommitment.id);
  const unresolved = (alloc.unresolved || []).find(r => r.id === undatedCommitment.id);

  ok(dated && dated.confidence === datedCommitment.confidence
    && dated.confidence === datedSeq.confidence,
    'futureCosts retains the plan commitment confidence, not a paydayAllocation invention');
  ok(dated && dated.date === datedCommitment.date,
    'the estimated dated commitment keeps its incumbent date');
  if (dated && dated.allocated > EPS) {
    ok(datedLine && datedLine.kind === 'future-cost'
      && datedLine.confidence === datedCommitment.confidence
      && datedLine.date === datedCommitment.date,
      'a positive future-cost line keeps the incumbent estimated date and confidence');
  } else {
    ok(dated && dated.confidence === datedCommitment.confidence,
      'a zero future-cost allocation still keeps the incumbent estimated confidence');
  }
  ok(unresolved && unresolved.confidence === undatedCommitment.confidence
    && unresolved.date == null,
    'unresolved retains estimated confidence and does not fabricate a date');
  ok(recon(alloc), 'estimated future-cost fixture still reconciles');
}

console.log('\n=== recommend attaches the same result ===');
{
  const rec = F.recommend(planA(), AS_OF, opts());
  const direct = F.paydayAllocation(planA(), AS_OF, opts());
  ok(rec.paydayAllocation, 'Forecast.recommend attaches paydayAllocation');
  ok(near(rec.paydayAllocation.available, direct.available)
    && near(future(rec.paydayAllocation, 'oct').allocated, future(direct, 'oct').allocated),
    'the attached result matches a direct call');
}

console.log('\n=== no second planner name ===');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'forecast.js'), 'utf8')
    + fs.readFileSync(path.join(__dirname, '..', 'public', 'plan.js'), 'utf8');
  ok(!/function paydayEngine|Forecast\.paydayPlan/.test(src),
    'paydayAllocation extends Forecast; it is not a second payday planner');
  ok(!/function futurePaydayCaps|function settleFuturePaydayDeficits|function requiredNowByCommitment/.test(src),
    'the parallel payday-cap capacity model is gone');
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll payday-allocation proofs passed.');
