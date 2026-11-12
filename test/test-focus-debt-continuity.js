'use strict';
/* AMANDA SLICE 6 — Focus debt continuity on the Budget payday shell.
 *
 * Amanda can always answer: which debt are we attacking, how much extra
 * goes there from this payday, and what debt comes next after this one
 * clears. The focus stays visible even when Forecast allocates $0 extra
 * principal — $0 never makes the debt strategy disappear.
 *
 * Every figure is a Forecast reprint from paydayAllocation.extraDebt
 * (allocated, status, reason, target, nextTarget, consequence, policy,
 * provenance). The page selects nothing: no debt choice, no rate
 * comparison, no ranking, no payoff or balance arithmetic, no reason
 * invented for $0. Unavailable fails closed; no next target is silence,
 * never "debt free".
 *
 * Shown on the default Budget payday shell ("Extra on focus debt"):
 * - focus debt label (always, including at $0);
 * - extra principal allocated this payday (including $0);
 * - required minimums identified as already in bills above (no double count);
 * - "After this debt clears: <next>" only from Forecast's published
 *   next-target consequence, kept conditional — never a current payment.
 *
 * Truth boundaries: a zero allocation is a fact, not automatically a
 * reason. Current target is not proof a payment was made; next target is
 * not a payment scheduled today. Absence of nextTarget does not mean
 * debt-free. Unknown pending exposure is preserved, never converted to
 * $0 or safe surplus. Synthetic fixtures only (L-006).
 *
 * `node test/test-focus-debt-continuity.js`
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
// Forecast publishes the debt-continuity facts the shell reprints
// (independent of the page fixtures below). Synthetic plan: two eligible
// revolving debts, owner-stated highest-interest policy.

function slice6Plan(cash, buffer) {
  return {
    defaults: { targetBuffer: buffer, extraDebtMonthly: 0 },
    opening: { asOf: '2026-01-02' },
    startingCash: { breakdown: [{ id: 'chequing-a', value: cash }] },
    income: [{ id: 'payroll', label: 'Seaspan', frequency: 'biweekly',
      anchor: '2026-01-02', amount: 3000, confidence: 'confirmed' }],
    obligations: [], bills: [], budget: { categories: [] }, commitments: [],
    nextDollar: { policy: 'true-surplus-highest-interest', provenance: 'owner-stated' },
  };
}

function slice6Debts() {
  return [
    { id: 'travel-visa', label: 'Travel Visa', structure: 'Revolving credit card',
      rate: 22.99, balance: 4000, limit: 10000, confidence: 'confirmed' },
    { id: 'triangle-mc', label: 'Triangle Mastercard', structure: 'Revolving credit card',
      rate: 19.99, balance: 2500, limit: 8000, confidence: 'confirmed' },
  ];
}

function slice6ExtraDebt(cash, buffer) {
  const alloc = F.paydayAllocation(slice6Plan(cash, buffer), '2026-01-02',
    { debts: slice6Debts(), weeklyVariable: 0 });
  return { extra: alloc.extraDebt, trust: alloc.paydayShellTrust.extraDebt };
}

check('A1: positive extra — Forecast names the target and the next target; the page selects neither', () => {
  const { extra, trust } = slice6ExtraDebt(5000, 0);
  assert.equal(extra.status, 'ready', 'strategy published as ready');
  assert.ok(extra.allocated > 0, 'positive extra allocated');
  assert.equal(extra.target.label, 'Travel Visa', 'current target published');
  assert.equal(extra.nextTarget.label, 'Triangle Mastercard', 'next target published');
  assert.ok(extra.consequence && extra.consequence.kind === 'next-target',
    'next-target consequence published');
  assert.equal(extra.consequence.condition, 'after-current-target-clears',
    'consequence is conditional, not a current payment');
  assert.equal(extra.consequence.nextTarget.label, 'Triangle Mastercard',
    'consequence names the published next target');
  // The engine chose by policy (highest rate first); the page never could.
  assert.ok(extra.target.rate > extra.nextTarget.rate, 'engine order is rate-descending');
  assert.equal(extra.policy, 'true-surplus-highest-interest', 'policy published');
  assert.equal(extra.provenance, 'owner-stated', 'provenance published');
  assert.equal(trust, 'calculated', 'shell trust published');
});

check('A2: $0 extra — the publication still carries the focus and the next target', () => {
  const { extra, trust } = slice6ExtraDebt(1000, 9000);
  assert.equal(extra.allocated, 0, 'zero allocated is a published fact');
  assert.equal(extra.status, 'ready', 'strategy still ready at $0');
  assert.equal(extra.target.label, 'Travel Visa', 'focus published at $0');
  assert.equal(extra.nextTarget.label, 'Triangle Mastercard', 'next target published at $0');
  assert.ok(extra.consequence && extra.consequence.kind === 'next-target',
    'consequence published at $0');
  assert.equal(extra.reason, 'Owner-stated policy sends true surplus to the highest-interest eligible revolving debt or HELOC.',
    'published reason is the policy statement, not a $0 causal claim');
  assert.equal(trust, 'calculated', 'trust intact at $0');
});

// ---------------------------------------------------------------- Part B ---
// Page reprint behaviour. Deterministic synthetic fixtures shaped exactly
// like the engine publication Part A verified.

const planSource = sourceText(fs.readFileSync(path.join(__dirname, '../public/plan.js'), 'utf8'));
const context = vm.createContext({
  Forecast: F,
  money2: n => (n < 0 ? '−$' : '$') + Math.abs(Number(n)).toLocaleString('en-CA',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  fmtDateLong: iso => new Date(iso + 'T00:00:00').toLocaleDateString('en-CA',
    { day: 'numeric', month: 'long' }),
  calendarWaterfallHtml: () => '<article data-waterfall>waterfall</article>',
  liveCurrentBalanceHtml: () => '<div data-live-current-balance>cash</div>',
});
vm.runInContext(planSource, context);
const P = context;

const travelVisa = { id: 'travel-visa', label: 'Travel Visa' };
const triangleMc = { id: 'triangle-mc', label: 'Triangle Mastercard' };
function nextTargetConsequence() {
  return { kind: 'next-target', condition: 'after-current-target-clears',
    target: travelVisa, nextTarget: triangleMc };
}

function allocFixture(overrides = {}) {
  return Object.assign({
    payday: '2026-01-02',
    asOf: '2026-01-02',
    lines: [{}],
    available: 5000,
    obligations: { allocated: 2000, shortfall: 0 },
    requiredDebtPayments: { items: [{ id: 'visa-min', label: 'Visa required minimum', amount: 150 }] },
    essentials: { allocated: 800 },
    extraDebt: { allocated: 450, target: travelVisa, status: 'ready',
      reason: 'Owner-stated policy sends true surplus to the highest-interest eligible revolving debt or HELOC.',
      policy: 'true-surplus-highest-interest', provenance: 'owner-stated',
      nextTarget: triangleMc, consequence: nextTargetConsequence() },
    remainder: 450,
    unresolved: [],
  }, overrides);
}

function adviceFixture(allocOverrides) {
  return {
    buffer: 500,
    paydayShellTrust: {
      available: 'calculated', obligations: 'calculated', household: 'calculated',
      extraDebt: 'calculated', optional: 'calculated', remainder: 'calculated',
      buffer: 'calculated',
    },
    paydayAllocation: allocFixture(allocOverrides),
    planSpendPaydayFunding: null,
    payPeriodViews: [{ id: 'current:2026-01-02', start: '2026-01-02', end: '2026-01-15', timelineRole: 'current' }],
    defaultView: { asOf: '2026-01-02' },
  };
}

const currentPeriod = { id: 'current:2026-01-02', start: '2026-01-02', end: '2026-01-15', timelineRole: 'current' };
const shell = (allocOverrides, period = currentPeriod) =>
  P.paydayInstructionShellHtml(adviceFixture(allocOverrides), period,
    // AMANDA SLICE 14: explicit schedule argument (null here — the
    // planned block fails closed; this file tests the extra-debt block).
    null);

// The "Extra on focus debt" block, scoped so other blocks cannot leak in.
function extraBlock(html) {
  const start = html.indexOf('<details class="instruction-block" data-payday-breakdown="Extra on focus debt"');
  assert.ok(start !== -1, 'Extra on focus debt block rendered');
  const end = html.indexOf('</details>', start);
  assert.ok(end !== -1, 'the semantic focus-debt row has its own closing boundary');
  return html.slice(start, end + '</details>'.length);
}

check('B1: positive extra — focus debt and exact allocation visible', () => {
  const block = extraBlock(shell());
  assert.match(block, /Travel Visa/, 'current focus debt named');
  assert.match(block, /\$450\.00/, 'exact extra allocation reprinted');
  assert.match(block, /<span class="trust-tag">calculated<\/span>/, 'published trust carried');
  assert.doesNotMatch(block, /\[object Object\]/, 'target object never interpolated raw');
});

check('B2: $0 extra — focus stays visible; $0 never erases the strategy or invents a reason', () => {
  const block = extraBlock(shell({ extraDebt: { allocated: 0, target: travelVisa, status: 'ready',
    reason: 'Owner-stated policy sends true surplus to the highest-interest eligible revolving debt or HELOC.',
    nextTarget: triangleMc, consequence: nextTargetConsequence() } }));
  assert.match(block, /\$0\.00/, '$0 shown as a fact');
  assert.match(block, /Focus debt: Travel Visa/, 'focus debt remains visible at $0');
  assert.match(block, /No extra principal this payday/, '$0 stated plainly');
  assert.doesNotMatch(block, /Required minimums are already in bills above/, "minimums explanation removed; the $0 state stays");
  assert.match(block, /Strategy note: Owner-stated policy sends true surplus/,
    'published strategy state shown separately, not as the reason for $0');
  assert.doesNotMatch(block, /because|since the|crowded|bills used|buffer prevented|cannot afford|paused/i,
    'no invented reason for the $0');
});

check('B3: next target reprinted as conditional — never a current payment', () => {
  const block = extraBlock(shell());
  assert.match(block, /After this debt clears: Triangle Mastercard/, 'next target reprinted');
  // The next target appears only in the conditional line, never beside an amount.
  const amounts = [...block.matchAll(/\$[\d,]+\.\d\d/g)].map(m => m[0]);
  assert.deepEqual(amounts, ['$450.00'], 'only the current-payday amount is shown');
  assert.doesNotMatch(block, /Triangle Mastercard.*\$|extra.*Triangle Mastercard.*this payday/i,
    'next target not framed as a current payment');
});

check('B4: no published next target — silence, never "debt free"', () => {
  const block = extraBlock(shell({ extraDebt: { allocated: 450, target: travelVisa, status: 'ready',
    nextTarget: null, consequence: null } }));
  assert.match(block, /Travel Visa/, 'focus still shown');
  assert.doesNotMatch(block, /After this debt clears/, 'no next-target line without publication');
  assert.doesNotMatch(block, /debt.?free|all debt paid|no more debt|last debt/i,
    'absence of nextTarget never claims debt-free');
});

check('B5: unavailable priority fails closed — published state rendered, no invented focus target', () => {
  const block = extraBlock(shell({ extraDebt: { allocated: 0, target: null, status: 'unavailable',
    reason: 'Travel Visa has an unknown balance.' } }));
  assert.match(block, /\$0\.00/, 'published $0 figure kept with its trust tag');
  assert.match(block, /Travel Visa has an unknown balance/, 'published strategy state rendered');
  assert.doesNotMatch(block, /Focus debt:/, 'no focus invented');
  assert.doesNotMatch(block, /After this debt clears/, 'no next target invented');
});

check('B6: unknown pending exposure — uncertainty stays visible; $0 stays non-causal', () => {
  const pendingReason = 'Travel Visa has unknown pending exposure; cash beyond the proven posted balance is not true surplus.';
  const block = extraBlock(shell({ extraDebt: { allocated: 0, target: travelVisa, status: 'ready',
    reason: pendingReason, nextTarget: triangleMc, consequence: nextTargetConsequence() } }));
  assert.match(block, /Focus debt: Travel Visa/, 'focus visible');
  assert.match(block, /\$0\.00/, '$0 shown as a fact');
  assert.match(block, /Strategy note: Travel Visa has unknown pending exposure/,
    'Forecast uncertainty remains visible, shown separately as published state');
  // The compact summary keeps the published uncertainty visible in its own
  // element. It never becomes the amount's trust tag or a reason for $0.
  const summary = block.split('</summary>')[0];
  assert.match(summary, /<span class="instruction-amount">\$0\.00 <span class="trust-tag">calculated<\/span><\/span>/,
    'the exact $0 figure and its published trust remain a separate headline');
  assert.match(summary, /<span class="instruction-warning">Strategy note: Travel Visa has unknown pending exposure; cash beyond the proven posted balance is not true surplus\.<\/span>/,
    'the verbatim published uncertainty remains a separate, visible summary note');
  assert.match(block.split('</summary>')[1], /Focus debt: Travel Visa\. No extra principal this payday\./,
    'the explanation still states the $0 fact and minimums without a causal claim');
  // The $0 itself stays non-causal: no "because", no invented mechanism.
  assert.doesNotMatch(block, /because|since the|crowded|bills used|buffer prevented|cannot afford|paused/i,
    'no causal story for the $0');
  // No safe-surplus claim: the only "surplus" on the block is Forecast's
  // own "not true surplus" uncertainty, reprinted verbatim.
  assert.doesNotMatch(block, /safe surplus|surplus available|surplus of \$|extra surplus/i,
    'no safe-surplus claim');
});

check('B7: clear state — published "no eligible target" renders as published, never as debt-free', () => {
  const block = extraBlock(shell({ extraDebt: { allocated: 0, target: null, status: 'clear',
    reason: 'No eligible revolving debt or HELOC has a known balance to receive surplus.',
    nextTarget: null, consequence: null } }));
  assert.match(block, /No eligible revolving debt or HELOC has a known balance/,
    'published clear state rendered');
  assert.doesNotMatch(block, /Focus debt:/, 'no debt invented');
  assert.doesNotMatch(block, /debt.?free|all debt paid/i, 'clear state never claims debt-free');
});

check('B8: required minimums are not double-counted in the extra block', () => {
  const zeroExtra = { allocated: 0, target: travelVisa, status: 'ready',
    nextTarget: triangleMc, consequence: nextTargetConsequence() };
  const html = shell({ extraDebt: zeroExtra });
  const block = extraBlock(html);
  assert.match(html, /\$2,000\.00/, 'bills block carries the required-minimums figure');
  assert.doesNotMatch(block, /\$2,000\.00/, 'bills figure not repeated in the extra block');
  assert.doesNotMatch(block, /already in bills above/, 'the explanation is removed; the bills figure is not repeated');
});

check('B9: positive extra with published uncertainty — strategy note stays visible too', () => {
  const pendingReason = 'Travel Visa has unknown pending exposure; cash beyond the proven posted balance is not true surplus.';
  const block = extraBlock(shell({ extraDebt: { allocated: 450, target: travelVisa, status: 'ready',
    reason: pendingReason, nextTarget: triangleMc, consequence: nextTargetConsequence() } }));
  assert.match(block, /\$450\.00/, 'exact extra allocation reprinted');
  assert.match(block, /Optional extra on Travel Visa/, 'focus named');
  assert.match(block, /Strategy note: Travel Visa has unknown pending exposure/,
    'Forecast uncertainty visible alongside a positive allocation');
  assert.doesNotMatch(block, /safe surplus|surplus available/i, 'no safe-surplus claim');
});

// ---------------------------------------------------------------- Part C ---
// Source guards: the page must not choose, rank, or compute debt figures.

const slice6Region = (() => {
  const start = planSource.indexOf('AMANDA SLICE 6');
  assert.ok(start !== -1, 'slice 6 block present in plan.js');
  const end = planSource.indexOf('const extraBlock', start);
  assert.ok(end !== -1 && end > start, 'slice 6 region bounded');
  return planSource.slice(start, end);
})();

check('C1: no page-side ordering of debts in the slice 6 region', () => {
  assert.doesNotMatch(slice6Region, /\.sort\(/, 'no sort() — Forecast order wins');
});

check('C2: no rate comparison or ordering constructs in the slice 6 region', () => {
  assert.doesNotMatch(slice6Region, /\.rate\b/i, 'no .rate reads — no rate comparison');
  assert.doesNotMatch(slice6Region, /\bscor/i, 'no scoring constructs');
});

check('C3: no financial computation in the slice 6 region', () => {
  assert.doesNotMatch(slice6Region, /Math\./, 'no Math.* — the page reprints, Forecast computes');
  assert.doesNotMatch(slice6Region, /\.balance\b/i, 'no balance reads — no post-payment arithmetic');
});

console.log(`\n${checks} checks passed.`);
