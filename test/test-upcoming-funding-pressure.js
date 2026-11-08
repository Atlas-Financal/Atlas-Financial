'use strict';
/* AMANDA SLICE 5 — Upcoming funding pressure on the payday shell.
 *
 * The default Budget payday experience answers Amanda's question: "Why does
 * planned-spending money need to go out now versus later — and is a later
 * unavoidable expense that gets little or $0 today still scheduled for
 * timely funding?" Every figure is a Forecast reprint from
 * planSpendPaydayFunding — the caller passes the same-input regenerated
 * schedule and the page reprints it, Forecast computes. No page-side
 * financial arithmetic, ranking, or ordering.
 *
 * Shown for the live payday (from Forecast's live payday row + costs[]):
 * - funding now: this payday's named allocations, each with its Forecast
 *   cash date ("Needed by")
 * - still in the plan: dated costs with no allocation this payday and a
 *   cash date not before this payday, each with "No funding from this payday", Forecast's next scheduled contribution, and the
 *   projected fully-funded date
 *
 * Truth boundaries: $0 today never means forgotten, complete, or
 * cancelled — the published future path is shown. A future scheduled
 * contribution never conceals a Slice 4 funding gap and never implies
 * "On track". Estimated costs keep the estimate tag; estimated is never
 * promoted. Unknown is not $0. Overdue costs are named by the gap block,
 * never listed as "nothing required". Synthetic fixtures only (L-006).
 *
 * `node test/test-upcoming-funding-pressure.js`
 */
const assert = require('assert/strict');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const F = require('../public/forecast.js');
const { sourceText } = require('./test-source-text');

let checks = 0;
function check(label, run) { run(); checks++; console.log('  PASS  ' + label); }

// ---------------------------------------------------------------- Part A ---
// Forecast publishes the per-cost future path the shell reprints
// (independent of the page fixtures below). Synthetic plan: a nearer cost
// due inside the first pay period and an annual property-tax-shaped cost
// months out.

function slice5Plan() {
  return {
    defaults: { targetBuffer: 0, extraDebtMonthly: 0 },
    opening: { asOf: '2026-01-02' },
    startingCash: { breakdown: [{ id: 'chequing-a', value: 0 }] },
    income: [{ id: 'payroll', label: 'Seaspan', frequency: 'biweekly',
      anchor: '2026-01-02', amount: 3000, confidence: 'confirmed' }],
    obligations: [], bills: [], budget: { categories: [] },
    commitments: [
      { id: 'fusion', label: 'Fusion', date: '2026-01-10', amount: 700, confidence: 'confirmed' },
      { id: 'proptax', label: 'Property tax', date: '2026-07-02', amount: 5639.67, confidence: 'estimated' },
    ],
  };
}

function slice5Schedule() {
  const plan = slice5Plan();
  const asOf = plan.opening.asOf;
  const sim = F.simulate(plan, asOf, { horizonDays: 200, viewDays: 200, weeklyVariable: 0 });
  const seq = F.fundingSequence(plan, asOf);
  return F.planSpendPaydayFunding(plan, asOf, sim, seq,
    F.majorPlans(plan, asOf, { weeklyVariable: 0 }));
}

check('A1: nearer cost funded today while the later cost gets $0 — later path published', () => {
  const schedule = slice5Schedule();
  assert.ok(schedule && schedule.status === 'ready', 'schedule ready, not unavailable');
  const row = schedule.paydays[0];
  assert.equal(row.payday, '2026-01-02', 'live payday row first');
  assert.equal(row.contribution, 700, 'live contribution funds the nearer cost only');
  assert.deepEqual(row.allocations.map(a => a.id), ['fusion'], 'only the nearer cost allocated today');
  const later = schedule.costs.find(c => c.id === 'proptax');
  assert.ok(later, 'later cost published');
  assert.equal(later.protectedAfterNextPayday, 0, '$0 from this payday');
  assert.ok(later.nextContribution, 'next scheduled contribution published');
  assert.equal(typeof later.nextContribution.payday, 'string', 'next contribution payday published');
  assert.ok(later.nextContribution.amount > 0, 'next contribution amount published');
  assert.equal(typeof later.projectedFullyFunded, 'string', 'projected fully-funded date published');
  assert.equal(later.confidence, 'estimated', 'estimated confidence published, not promoted');
  assert.equal(later.date, '2026-07-02', 'cash date published');
});

check('A2: later cost contributions differ across paydays — no equal-per-pay implication', () => {
  const schedule = slice5Schedule();
  const later = schedule.costs.find(c => c.id === 'proptax');
  const amounts = later.contributions.map(c => c.amount);
  assert.ok(amounts.length > 1, 'later cost funded across several paydays');
  assert.ok(new Set(amounts).size > 1, 'contribution amounts are not equal per payday');
});

check('A3: contributions reconcile — live allocations sum to the contribution', () => {
  const schedule = slice5Schedule();
  const row = schedule.paydays[0];
  const namedSum = row.allocations.reduce((sum, a) => sum + a.amount, 0);
  assert.ok(Math.abs(namedSum - row.contribution) < 0.005, 'named allocations sum to the contribution');
  for (const cost of schedule.costs) {
    const funded = cost.contributions.reduce((sum, c) => sum + c.amount, 0);
    assert.ok(Math.abs(funded - (cost.baseRequirement - cost.remainingAfterSchedule)) < 0.005,
      `${cost.id}: contributions reconcile to the funded portion`);
  }
});

// ---------------------------------------------------------------- Part B ---
// Page reprint behaviour. Deterministic synthetic fixtures shaped exactly
// like the engine publication Part A verified.

const planSource = sourceText(fs.readFileSync(path.join(__dirname, '../public/plan.js'), 'utf8'));
const context = vm.createContext({ escapeHtml: require('./app-escape-html'),
  Forecast: F,
  money2: n => (n < 0 ? '−$' : '$') + Math.abs(Number(n)).toLocaleString('en-CA',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  // app.js household date formatter, stubbed identically for the VM.
  fmtDateLong: iso => new Date(iso + 'T00:00:00').toLocaleDateString('en-CA',
    { day: 'numeric', month: 'long' }),
});
vm.runInContext(planSource, context);
const P = context;

function allocFixture(overrides = {}) {
  return Object.assign({
    payday: '2026-01-02',
    asOf: '2026-01-02',
    lines: [{}],
    available: 5000,
    obligations: { allocated: 0, shortfall: 0 },
    essentials: { allocated: 0 },
    extraDebt: { allocated: 0, target: { id: 'x', label: 'X' }, status: 'ok' },
    remainder: 0,
    unresolved: [],
    optional: [],
  }, overrides);
}

function paydayRow(overrides = {}) {
  return Object.assign({
    payday: '2026-01-02',
    contribution: 700,
    allocations: [{ id: 'fusion', label: 'Fusion', amount: 700 }],
    protectedAfterPayday: 700,
    stillToFund: 5639.67,
    nonPlanSpendProtected: 0,
    trust: 'calculated',
  }, overrides);
}

function costFixture(overrides = {}) {
  return Object.assign({
    id: 'fusion', label: 'Fusion', date: '2026-01-10', confidence: 'confirmed',
    nextContribution: { payday: '2026-01-02', amount: 700 },
    projectedFullyFunded: '2026-01-02',
  }, overrides);
}

function scheduleFixture(overrides = {}) {
  return Object.assign({
    status: 'ready',
    source: 'Forecast.planSpendPaydayFunding',
    // AMANDA SLICE 14: the live row is the row whose payday equals the
    // schedule's asOf (the real publication contract).
    asOf: '2026-01-02',
    fundingTrust: 'calculated',
    paydays: [paydayRow()],
    gap: null,
    costs: [
      costFixture(),
      costFixture({ id: 'proptax', label: 'Property tax', date: '2026-07-02',
        confidence: 'estimated',
        nextContribution: { payday: '2026-06-05', amount: 2639.67 },
        projectedFullyFunded: '2026-06-19' }),
    ],
  }, overrides);
}

function adviceFixture(allocOverrides, scheduleOverrides) {
  return {
    buffer: 500,
    paydayShellTrust: {
      available: 'calculated', obligations: 'calculated', household: 'calculated',
      extraDebt: 'calculated', optional: 'calculated', remainder: 'calculated',
      buffer: 'calculated',
    },
    paydayAllocation: allocFixture(allocOverrides),
    planSpendPaydayFunding: scheduleOverrides === null ? null : scheduleFixture(scheduleOverrides),
    payPeriodViews: [{ id: 'current:2026-01-02', start: '2026-01-02', end: '2026-01-15', timelineRole: 'current' }],
    defaultView: { asOf: '2026-01-02' },
  };
}

const currentPeriod = { id: 'current:2026-01-02', start: '2026-01-02', end: '2026-01-15', timelineRole: 'current' };
const shell = (allocOverrides, scheduleOverrides, period = currentPeriod) =>
  P.paydayInstructionShellHtml(adviceFixture(allocOverrides, scheduleOverrides), period,
    // AMANDA SLICE 14: explicit same-input schedule argument.
    scheduleOverrides === null ? null : scheduleFixture(scheduleOverrides));

// The "Still in the plan" subsection, scoped so later-block assertions
// cannot leak into it.
function stillPlannedSection(html) {
  const start = html.indexOf('Still in the plan');
  assert.ok(start !== -1, 'Still in the plan section rendered');
  const end = html.indexOf('If this plan is followed', start);
  return html.slice(start, end === -1 ? undefined : end);
}

check('B1: funding-now line reprints label, amount, and the Forecast cash date', () => {
  const html = shell();
  assert.match(html, /Fusion.*\$700\.00/s, 'named allocation reprinted');
  assert.match(html, /Needed by.*January 10/s, 'Forecast cash date reprinted, not invented');
});

check('B2: $0-today cost stays visible with its future path — never forgotten/complete/cancelled', () => {
  const section = stillPlannedSection(shell());
  assert.match(section, /Property tax/, 'later cost named');
  assert.match(section, /No funding from this payday/, 'honest $0-today wording states the fact, not a reason');
  assert.match(section, /Next scheduled contribution.*\$2,639\.67.*on.*June 5/s, 'next contribution reprinted exactly');
  assert.match(section, /Projected funded by.*June 19/s, 'projected funded-by reprinted');
  assert.doesNotMatch(section, /forgotten|complete|cancelled/i, 'no false terminal wording');
});

check('B3: page keeps Forecast publication order — no page-side sort or rank', () => {
  // Deliberately non-chronological publication order; the page must not fix it.
  const html = shell({}, {
    costs: [
      costFixture({ id: 'proptax', label: 'Property tax', date: '2026-07-02',
        confidence: 'estimated',
        nextContribution: { payday: '2026-06-05', amount: 2639.67 },
        projectedFullyFunded: '2026-06-19' }),
      costFixture({ id: 'anniv', label: 'Anniversary', date: '2026-03-15',
        confidence: 'confirmed',
        nextContribution: { payday: '2026-02-27', amount: 200 },
        projectedFullyFunded: '2026-02-27' }),
      costFixture(),
    ],
  });
  const section = stillPlannedSection(html);
  assert.ok(section.indexOf('Property tax') < section.indexOf('Anniversary'),
    'publication order preserved, not date-sorted page-side');
});

check('B4: $0 contribution still shows the future path — $0 today is not fully funded', () => {
  const html = shell({}, {
    paydays: [paydayRow({ contribution: 0, allocations: [] })],
  });
  assert.match(html, /No Nest Money earmark this payday/);
  const section = stillPlannedSection(html);
  assert.match(section, /Property tax/, 'later cost still listed when today is $0');
  assert.match(section, /Next scheduled contribution.*\$2,639\.67/s, 'future path still shown');
  assert.doesNotMatch(section, /fully funded/i);
});

check('B5: estimated cost keeps the estimate tag — never promoted to calculated', () => {
  // Forecast's fundingTrust is the weakest of every dated cost's confidence
  // (see A-part and C6 checks), so a schedule holding an estimated cost
  // publishes fundingTrust 'estimated'. The projected lines reprint it.
  const section = stillPlannedSection(shell({}, { fundingTrust: 'estimated' }));
  assert.match(section, /Next scheduled contribution.*<span class="trust-tag trust-estimated">estimate<\/span>/s,
    'next contribution carries the estimate tag');
  assert.match(section, /Projected funded by.*<span class="trust-tag trust-estimated">estimate<\/span>/s,
    'funded-by carries the estimate tag');
  assert.doesNotMatch(section, /trust-tag">calculated</, 'no calculated tag on the estimated cost');
  // …while the confirmed nearer cost keeps its own confirmed tag.
  assert.match(shell(), /Needed by.*<span class="trust-tag">confirmed<\/span>/s);
});

check('B5b (C6): confirmed cost on an estimated funding path — projections say estimate, never confirmed', () => {
  // Invented case: the cost itself is confirmed, but the payday funding path
  // is estimated. Next contribution and funded-by are funding-path figures.
  const html = shell({}, {
    fundingTrust: 'estimated',
    costs: [
      costFixture(),
      costFixture({ id: 'trip', label: 'Invented trip', date: '2026-04-20',
        confidence: 'confirmed',
        nextContribution: { payday: '2026-03-27', amount: 321.45 },
        projectedFullyFunded: '2026-04-10' }),
    ],
  });
  const section = stillPlannedSection(html);
  assert.match(section, /Next scheduled contribution<\/span><span>\$321\.45 <span class="trust-tag trust-estimated">estimate<\/span> on March 27/,
    'next contribution carries the funding trust');
  assert.match(section, /Projected funded by<\/span><span>April 10 <span class="trust-tag trust-estimated">estimate<\/span>/,
    'funded-by carries the funding trust');
  assert.doesNotMatch(section, /confirmed/, 'no funding-path line is tagged confirmed');
});

check('B5c (C6): unpublished funding trust fails the projected lines closed — never borrowed from the cost', () => {
  const html = shell({}, { fundingTrust: null });
  // Without published funding trust the "If this plan is followed" block is
  // omitted too, so bound the section at the end of its own line list.
  const full = stillPlannedSection(html);
  const section = full.slice(0, full.indexOf('</div></div>') + 12);
  assert.match(section, /Property tax/, 'cost still named');
  assert.match(section, /Next scheduled contribution.*unavailable — trust not published/s);
  assert.match(section, /Projected funded by.*unavailable — trust not published/s);
  assert.doesNotMatch(section, /\$2,639\.67/, 'untrusted contribution never shown');
  assert.doesNotMatch(section, /June 19/, 'untrusted funded-by date never shown');
  assert.doesNotMatch(section, /\$0\.00/, 'unknown never rendered as $0');
});

check('B5d (C6): real Forecast output — confirmed cost, estimated income — page never tags the path confirmed', () => {
  // End-to-end through Forecast then the page: an estimated income makes the
  // funding path estimated while both costs stay confirmed.
  const plan = slice5Plan();
  plan.income[0].confidence = 'estimated';
  plan.commitments[1].confidence = 'confirmed';
  const asOf = plan.opening.asOf;
  const knob = { weeklyVariable: 0 };
  const sim = F.simulate(plan, asOf, { horizonDays: 200, viewDays: 200, weeklyVariable: 0 });
  const plans = F.majorPlans(plan, asOf, knob);
  const alloc = F.paydayAllocation(plan, asOf, Object.assign({}, knob, { majorPlans: plans }));
  const schedule = F.planSpendPaydayFunding(plan, asOf, sim, F.fundingSequence(plan, asOf, knob), plans, alloc);
  assert.equal(schedule.fundingTrust, 'estimated', 'Forecast publishes an estimated funding path');
  assert.equal(schedule.costs.find(c => c.id === 'proptax').confidence, 'confirmed', 'the cost itself is confirmed');
  const advice = Object.assign({}, adviceFixture(), alloc, { planSpendPaydayFunding: schedule });
  const html = P.paydayInstructionShellHtml(advice, currentPeriod, schedule);
  const section = stillPlannedSection(html);
  assert.match(section, /Next scheduled contribution[\s\S]*trust-estimated">estimate/, 'contribution tagged estimate');
  assert.match(section, /Projected funded by[\s\S]*trust-estimated">estimate/, 'funded-by tagged estimate');
  assert.doesNotMatch(section, /Next scheduled contribution[^.]{0,80}confirmed/, 'contribution not tagged confirmed');
  assert.doesNotMatch(section, /Projected funded by[^.]{0,80}confirmed/, 'funded-by not tagged confirmed');
});

check('B6: unpublished per-cost trust fails the future figures closed — never $0, never untagged', () => {
  const html = shell({}, {
    costs: [
      costFixture(),
      costFixture({ id: 'proptax', label: 'Property tax', date: '2026-07-02',
        confidence: null,
        nextContribution: { payday: '2026-06-05', amount: 2639.67 },
        projectedFullyFunded: '2026-06-19' }),
    ],
  });
  const section = stillPlannedSection(html);
  assert.match(section, /Property tax/, 'cost still named');
  assert.match(section, /Future funding details.*unavailable — trust not published/s);
  assert.doesNotMatch(section, /\$2,639\.67/, 'untrusted amount never shown');
  assert.doesNotMatch(section, /\$0\.00/, 'unknown never rendered as $0');
});

check('B7: no scheduled next contribution renders "none scheduled" — never $0', () => {
  const html = shell({}, {
    costs: [
      costFixture(),
      costFixture({ id: 'proptax', label: 'Property tax', date: '2026-07-02',
        confidence: 'estimated', nextContribution: null, projectedFullyFunded: null }),
    ],
  });
  const section = stillPlannedSection(html);
  assert.match(section, /Next scheduled contribution.*none scheduled/s);
  assert.match(section, /Projected funded by.*not published/s);
  assert.doesNotMatch(section, /\$0\.00/, 'no $0 invented for the missing path');
});

check('B8: overdue cost is not listed under Still in the plan — the gap block names it', () => {
  const html = shell({}, {
    status: 'funding-gap',
    fundingTrust: 'estimated',
    gap: { payday: null, cashDate: '2025-12-20', required: 400, available: 0,
      shortBy: 400, affected: ['overdue'] },
    costs: [
      costFixture(),
      costFixture({ id: 'overdue', label: 'Overdue bill', date: '2025-12-20',
        confidence: 'confirmed', nextContribution: null, projectedFullyFunded: null }),
      costFixture({ id: 'proptax', label: 'Property tax', date: '2026-07-02',
        confidence: 'estimated',
        nextContribution: { payday: '2026-06-05', amount: 2639.67 },
        projectedFullyFunded: '2026-06-19' }),
    ],
  });
  const section = stillPlannedSection(html);
  assert.doesNotMatch(section, /Overdue bill/, 'overdue cost excluded from Still in the plan');
  assert.match(html, /Funding shortfall ahead/, 'gap block rendered');
  assert.match(html, /Overdue bill/, 'overdue cost named by the gap block');
});

check('B10: P1 regression — the page never asserts a reason for $0 today', () => {
  // Systems Review BLOCKING on head 942dff5c: a cost receiving $0 today was
  // described as "Nothing required from this payday" when the real reason
  // could be that the payday cannot fund what was required (crowded out by
  // nearer costs, or a funding gap). The publication carries the fact, not
  // the reason, so the page must state the fact only.
  const html = shell({}, {
    status: 'funding-gap',
    fundingTrust: 'estimated',
    gap: { payday: '2026-06-05', cashDate: '2026-07-02', required: 5639.67,
      available: 2639.67, shortBy: 3000, affected: ['proptax'] },
  });
  const section = stillPlannedSection(html);
  assert.match(section, /Property tax/, 'later cost still named');
  assert.match(section, /No funding from this payday/, 'fact stated');
  assert.doesNotMatch(section, /nothing required/i, 'no reason asserted for the $0');
  assert.doesNotMatch(section, /not (yet |currently )?needed/i, 'no "not needed" wording either');
  // The gap block — Forecast's own published reason — still stands alongside.
  assert.match(html, /Funding shortfall ahead/, 'gap block unaffected');
});

check('B9: funding gap — future path shown AND shortfall shown, never "On track"', () => {
  const html = shell({}, {
    status: 'funding-gap',
    fundingTrust: 'estimated',
    gap: { payday: '2026-06-05', cashDate: '2026-07-02', required: 5639.67,
      available: 2639.67, shortBy: 3000, affected: ['proptax'] },
  });
  const section = stillPlannedSection(html);
  assert.match(section, /Property tax/, 'later cost future path still visible');
  assert.match(section, /Next scheduled contribution.*\$2,639\.67/s, 'scheduled contribution not hidden');
  assert.match(html, /Funding shortfall ahead/, 'shortfall block rendered');
  assert.match(html, /Short by.*\$3,000\.00/s, 'shortfall amount reprinted');
  assert.doesNotMatch(html, /On track/, 'gap never implies On track');
});

// ---------------------------------------------------------------- Part C ---
// Source guards: the page must not rank, score, sort, or compute.

const slice5Region = (() => {
  const start = planSource.indexOf('AMANDA SLICE 5');
  assert.ok(start !== -1, 'slice 5 block present in plan.js');
  const end = planSource.indexOf('const plannedBlock', start);
  assert.ok(end !== -1 && end > start, 'slice 5 region bounded');
  return planSource.slice(start, end);
})();

check('C1: no page-side ordering of costs in the slice 5 region', () => {
  assert.doesNotMatch(slice5Region, /\.sort\(/, 'no sort() — Forecast order kept');
});

check('C2: no priority/rank/score constructs in the slice 5 region', () => {
  // Property access or assignment — prose mentions in comments do not count.
  assert.doesNotMatch(slice5Region, /\.(priority|rank|score)\b/i, 'no .priority/.rank/.score reads');
  assert.doesNotMatch(slice5Region, /\b(priorityScore|rankScore|priorityRank)\b/i, 'no ranking variables');
});

check('C3: no Math.* financial computation in the slice 5 region', () => {
  assert.doesNotMatch(slice5Region, /Math\./, 'no Math.* — the page reprints, Forecast computes');
});

console.log(`\n${checks} checks passed.`);
