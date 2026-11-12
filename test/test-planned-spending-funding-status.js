'use strict';
/* AMANDA SLICE 4 — Planned-spending funding status on the payday shell.
 *
 * The default Budget payday shell answers Amanda's question: "After
 * following this payday plan, are our upcoming planned expenses on track,
 * and how much is still left to fund?" Every figure is a Forecast reprint
 * from planSpendPaydayFunding — the page selects and reprints, Forecast
 * computes. No page-side financial arithmetic.
 *
 * Shown for the live payday (from Forecast's live payday row):
 * - this payday's planned-spending earmark (contribution) + named allocations
 * - projected protected after following this payday's plan (protectedAfterPayday)
 * - still to fund (stillToFund)
 * - overall funding status (ready -> "On track"; funding-gap -> the gap block)
 * - a Forecast-published funding gap: shortfall (shortBy), date
 *   (gap.cashDate / gap.payday), affected named costs (id->label via costs[])
 *
 * Truth boundaries: protectedAfterPayday is a projection if the plan is
 * followed — never "already saved", "Nest Money balance", or "you have
 * moved". A $0 contribution does not mean fully funded. Unknown is not $0.
 * General protected cash (incl. pending debits), the buffer floor, bills,
 * extra debt, optional plans and unassigned money stay out of the Plan
 * Spend figures. Synthetic fixtures only (L-006).
 *
 * `node test/test-planned-spending-funding-status.js`
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
// Forecast publishes the funding-status fields the shell reprints
// (independent of the page fixtures below).

check('A1: the live engine publishes the funding-status fields the shell reprints', () => {
  const plan = {
    defaults: { targetBuffer: 0, extraDebtMonthly: 0 },
    opening: { asOf: '2026-01-01' },
    startingCash: { breakdown: [{ id: 'chequing-a', value: 0 }] },
    income: [{ id: 'payroll', label: 'Seaspan', frequency: 'biweekly',
      anchor: '2026-01-02', amount: 3000, confidence: 'confirmed' }],
    obligations: [], bills: [], budget: { categories: [] },
    commitments: [
      { id: 'fusion', label: 'Fusion', date: '2026-01-31', amount: 900, confidence: 'confirmed' },
    ],
  };
  const asOf = plan.opening.asOf;
  const sim = F.simulate(plan, asOf, { horizonDays: 60, viewDays: 60, weeklyVariable: 0 });
  const seq = F.fundingSequence(plan, asOf);
  const schedule = F.planSpendPaydayFunding(plan, asOf, sim, seq,
    F.majorPlans(plan, asOf, { weeklyVariable: 0 }));
  assert.ok(schedule && schedule.status !== 'unavailable', 'schedule published');
  assert.ok(['ready', 'funding-gap'].includes(schedule.status), 'status published');
  const row = schedule.paydays[0];
  assert.ok(row && row.payday, 'live payday row published');
  assert.ok(Number.isFinite(Number(row.contribution)), 'contribution published');
  assert.ok(Number.isFinite(Number(row.protectedAfterPayday)), 'protectedAfterPayday published');
  assert.ok(Number.isFinite(Number(row.stillToFund)), 'stillToFund published');
  assert.ok(Array.isArray(row.allocations), 'allocations published');
});

// P1 repair: an estimated future planned cost drives the schedule's gap,
// so the funding-status trust must be estimated even though nothing about
// the near costs changed. The confirmed-control proves the estimated
// confidence alone flips the trust.
function gapSchedule(roofConfidence) {
  const plan = {
    defaults: { targetBuffer: 0, extraDebtMonthly: 0 },
    opening: { asOf: '2026-01-01' },
    startingCash: { breakdown: [{ id: 'chequing-a', value: 0 }] },
    income: [{ id: 'payroll', label: 'Seaspan', frequency: 'biweekly',
      anchor: '2026-01-02', amount: 1000, confidence: 'confirmed' }],
    obligations: [], bills: [], budget: { categories: [] },
    commitments: [
      { id: 'furnace', label: 'Furnace', date: '2026-01-31', amount: 1500, confidence: 'confirmed' },
      { id: 'roof', label: 'Roof', date: '2026-02-20', amount: 9000, confidence: roofConfidence },
    ],
  };
  const asOf = plan.opening.asOf;
  const sim = F.simulate(plan, asOf, { horizonDays: 60, viewDays: 60, weeklyVariable: 0 });
  const seq = F.fundingSequence(plan, asOf);
  return F.planSpendPaydayFunding(plan, asOf, sim, seq,
    F.majorPlans(plan, asOf, { weeklyVariable: 0 }));
}

check('A2: an estimated future planned cost drives the gap — fundingTrust is estimated, not calculated', () => {
  const s = gapSchedule('estimated');
  assert.equal(s.status, 'funding-gap', 'schedule is in funding-gap');
  assert.ok(s.gap && Number(s.gap.shortBy) > 0, 'shortfall published');
  assert.ok(s.gap.affected.includes('roof'), 'estimated future cost drives the gap');
  assert.equal(s.fundingTrust, 'estimated', 'funding trust reflects the estimated input');
  const control = gapSchedule('confirmed');
  assert.equal(control.status, 'funding-gap', 'control is also in funding-gap');
  assert.equal(control.fundingTrust, 'calculated', 'confirmed inputs keep calculated trust');
});

// ---------------------------------------------------------------- Part B ---
// Page reprint behaviour. Deterministic synthetic fixtures.
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
    payday: '2026-09-25',
    asOf: '2026-09-25',
    lines: [{}],
    available: 5000,
    obligations: { allocated: 2000, shortfall: 0 },
    essentials: { allocated: 800 },
    extraDebt: { allocated: 250, target: { id: 'travel-visa', label: 'Travel Visa' }, status: 'ok' },
    remainder: 450,
    unresolved: [],
    optional: [],
  }, overrides);
}

function paydayRow(overrides = {}) {
  return Object.assign({
    payday: '2026-09-25',
    contribution: 1200,
    allocations: [
      { id: 'fusion', label: 'Fusion', amount: 700 },
      { id: 'proptax', label: 'Property tax', amount: 500 },
    ],
    protectedAfterPayday: 2300,
    stillToFund: 1800,
    nonPlanSpendProtected: 300,
    trust: 'calculated',
  }, overrides);
}

function scheduleFixture(overrides = {}) {
  return Object.assign({
    status: 'ready',
    source: 'Forecast.planSpendPaydayFunding',
    // AMANDA SLICE 14: the live row is the row whose payday equals the
    // schedule's asOf (the real publication contract).
    asOf: '2026-09-25',
    // Trust authority for the funding-status figures (AMANDA SLICE 4 P1
    // repair): Forecast publishes this; the page only reprints it.
    fundingTrust: 'calculated',
    paydays: [paydayRow()],
    gap: null,
    costs: [
      { id: 'fusion', label: 'Fusion' },
      { id: 'proptax', label: 'Property tax' },
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
    payPeriodViews: [{ id: 'current:2026-09-25', start: '2026-09-25', end: '2026-10-08', timelineRole: 'current' }],
    defaultView: { asOf: '2026-09-25' },
  };
}

const currentPeriod = { id: 'current:2026-09-25', start: '2026-09-25', end: '2026-10-08', timelineRole: 'current' };
const shell = (allocOverrides, scheduleOverrides, period = currentPeriod) =>
  P.paydayInstructionShellHtml(adviceFixture(allocOverrides, scheduleOverrides), period,
    // AMANDA SLICE 14: explicit same-input schedule argument.
    scheduleOverrides === null ? null : scheduleFixture(scheduleOverrides));

check('S1: ready payday shows earmark, named allocations, projected protected, still to fund, On track', () => {
  const html = shell();
  assert.match(html, /\$1,200\.00/); // earmark
  assert.match(html, /Fusion.*\$700\.00/s);
  assert.match(html, /Property tax.*\$500\.00/s);
  assert.match(html, /Projected protected.*\$2,300\.00/s);
  assert.match(html, /Still to fund.*\$1,800\.00/s);
  assert.match(html, /Status.*On track/s);
});

check('S2: $0 contribution with remaining funding renders both facts — $0 is not fully funded', () => {
  const html = shell({}, { paydays: [paydayRow({
    contribution: 0, allocations: [], protectedAfterPayday: 1100, stillToFund: 1800,
  })] });
  assert.match(html, /No Nest Money earmark this payday/);
  assert.match(html, /Still to fund.*\$1,800\.00/s);
  assert.match(html, /Projected protected.*\$1,100\.00/s);
  assert.doesNotMatch(html, /fully funded/i);
});

check('S3: funding gap exposes shortfall, date, and affected named costs — including a future payday', () => {
  const html = shell({}, {
    status: 'funding-gap',
    paydays: [paydayRow()],
    gap: { payday: '2026-10-09', cashDate: '2026-10-20', required: 2000,
      available: 1500, shortBy: 500, affected: ['proptax'] },
  });
  assert.match(html, /Funding shortfall ahead/);
  assert.match(html, /Short by.*\$500\.00/s);
  assert.match(html, /When.*October 20/s);
  assert.match(html, /Affected.*Property tax/s);
});

check('S4: unavailable schedule fails the funding status closed — unknown is not $0', () => {
  const html = shell({}, null);
  assert.match(html, /Nest Money funding plan: unavailable/);
  assert.doesNotMatch(html, /Projected protected/);
  assert.doesNotMatch(html, /Still to fund/);
  assert.doesNotMatch(html, /Funding shortfall ahead/);
});

check('S5: projection wording never claims money moved or saved', () => {
  const html = shell();
  assert.match(html, /Projected protected/);
  assert.doesNotMatch(html, /a projection, not money already moved or saved/);
  assert.doesNotMatch(html, /already saved/i);
  assert.doesNotMatch(html, /Nest Money balance/i);
  assert.doesNotMatch(html, /you have moved/i);
});

check('S6: unrelated protected cash never enters the Plan Spend funding figures', () => {
  const html = shell({}, { paydays: [paydayRow({ nonPlanSpendProtected: 4321 })] });
  // The $4,321 general hold appears exactly once — in its own keep-in-chequing block.
  assert.equal((html.match(/\$4,321\.00/g) || []).length, 1);
  assert.match(html, /Other protected cash — keep in chequing/);
  assert.match(html, /Projected protected.*\$2,300\.00/s);
});

check('S7: projected protected is the Forecast figure only — general protection is not folded in', () => {
  const html = shell({}, { paydays: [paydayRow({ protectedAfterPayday: 2300, nonPlanSpendProtected: 4321 })] });
  assert.match(html, /Projected protected.*\$2,300\.00/s);
  assert.doesNotMatch(html, /\$6,621\.00/); // never contribution + general hold by page arithmetic
});

check('S8: required debt minimums are not double-counted into planned spending', () => {
  const html = shell();
  const start = html.indexOf('<h3>Nest Money funding plan'); // AMANDA SLICE 14: dated title
  assert.ok(start !== -1, 'Nest Money block present');
  const next = html.indexOf('<h3>', start + 1);
  const block = next === -1 ? html.slice(start) : html.slice(start, next);
  assert.doesNotMatch(block, /\$2,000\.00/); // bills figure (incl. minimums) stays out
  assert.match(html, /Bills &amp; required minimums/);
});

check('S9: the Slice 4 funding-status code performs no page-side financial arithmetic', () => {
  // Static check: the new code selects, formats, labels, and arranges —
  // never combines financial values.
  const slice4 = planSource.slice(
    planSource.indexOf('AMANDA SLICE 4'),
    planSource.indexOf('const plannedBlock')
  );
  assert.ok(slice4.length > 500, 'Slice 4 section found');
  const lines = slice4.split('\n');
  const bad = lines.filter(line => {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*')) return false;
    // Forbid arithmetic combining the funding figures (either operand side).
    // money2(), Number(), known(), comparisons and ternaries are presentation.
    return /\b(protectedAfter|stillToFund|shortBy|contribution)\b\s*[-+*/%]/.test(t)
      || /[-+*/%]\s*\b(protectedAfter|stillToFund|shortBy|contribution)\b/.test(t);
  });
  assert.deepEqual(bad, [], `no arithmetic on funding figures, found: ${bad.join(' | ')}`);
});

check('S10: Slice 1/2/3 shell behavior is intact', () => {
  const html = shell();
  assert.match(html, /trust-tag/); // Slice 1 trust tags
  assert.doesNotMatch(html, /Atlas can't see money you've already moved/); // Slice 2 blindness qualifier
  assert.match(html, /Today's money — current position/);
});

check('S11: P1 — the shell cannot label an estimate-driven shortfall calculated', () => {
  // The P1 trap: the live row's Slice 1 stamp is calculated, but the
  // funding-status authority is estimated (an estimated future planned
  // cost drives the gap). The shortfall must carry the estimate tag and
  // never borrow the live row's calculated tag.
  const html = shell({}, {
    status: 'funding-gap',
    fundingTrust: 'estimated',
    paydays: [paydayRow({ trust: 'calculated' })],
    gap: { payday: '2026-10-09', cashDate: '2026-10-20', required: 9000,
      available: 2500, shortBy: 6500, affected: ['proptax'] },
  });
  // The earmark still carries the live row's own calculated tag…
  assert.match(html, /Nest Money funding plan[\s\S]*\$1,200\.00 <span class="trust-tag">calculated<\/span>/);
  // …but the funding-status figures carry the estimate tag instead.
  assert.match(html, /Short by.*\$6,500\.00 <span class="trust-tag trust-estimated">estimate<\/span>/s);
  assert.match(html, /Still to fund.*<span class="trust-tag trust-estimated">estimate<\/span>/s);
  assert.match(html, /Projected protected.*<span class="trust-tag trust-estimated">estimate<\/span>/s);
  // No calculated tag may appear on any funding-status figure. Scope to the
  // funding-status subsection + gap block (later blocks legitimately carry
  // their own calculated tags).
  const fundingStart = html.indexOf('Projected protected');
  assert.ok(fundingStart !== -1, 'funding-status subsection rendered');
  const fundingSection = html.slice(fundingStart, html.indexOf('<h3>Protected cash</h3>'));
  assert.doesNotMatch(fundingSection, /trust-tag">calculated</);
});

check('S12: unpublished funding trust fails the funding-status figures closed — never untagged', () => {
  const html = shell({}, { fundingTrust: null });
  // The earmark (whose trust is the live row's own stamp) still renders…
  assert.match(html, /\$1,200\.00/);
  // …but the funding-status figures and the gap block are omitted.
  assert.doesNotMatch(html, /Projected protected/);
  assert.doesNotMatch(html, /Still to fund/);
  assert.doesNotMatch(html, /Funding shortfall ahead/);
});

console.log(`\n${checks} checks passed.`);
